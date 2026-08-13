// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import Mime from "@effect/platform-node/Mime";
import { ATTACHMENT_UPLOAD_MAX_BYTES, AttachmentUploadError } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

import { resolveAttachmentRelativePath } from "./attachmentPaths.ts";
import { ATTACHMENT_UPLOADS_DIRECTORY, createAttachmentId } from "./attachmentStore.ts";
import { parseBase64DataUrl } from "./imageMime.ts";

const EXTENSION_PATTERN = /\.([a-z0-9]{1,12})$/i;

/** Total budget for uploaded documents that are not tied to a live thread yet. */
export const ATTACHMENT_UPLOADS_TOTAL_MAX_BYTES = 512 * 1024 * 1024;

// Budget check and write have to be one critical section, otherwise two uploads
// both read an under-budget total and both write. Uploads are rare and small in
// number, so a single process-wide queue is enough; per-directory locks would
// only matter if one process served many attachment roots.
let uploadQueue: Promise<unknown> = Promise.resolve();

function withUploadLock<A>(run: () => Promise<A>): Promise<A> {
  const next = uploadQueue.then(run, run);
  uploadQueue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

/**
 * Uploads whose draft was abandoned, or whose link the author deleted before
 * sending, are unreachable: nothing records them, so only age can retire them.
 * Thread deletion still reclaims referenced uploads immediately.
 */
export const ATTACHMENT_UPLOAD_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Guards inode exhaustion, which a byte budget alone does not bound. */
export const ATTACHMENT_UPLOADS_MAX_FILES = 2000;

type UploadOutcome = "written" | "over-budget" | "too-many-files";

interface UploadsDirectoryUsage {
  readonly totalBytes: number;
  readonly fileCount: number;
}

function isMissingFileError(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    (cause.code === "ENOENT" || cause.code === "ENOTDIR")
  );
}

/**
 * Recomputed per upload rather than cached: thread deletion removes files behind
 * our back, so a cached total would drift. Expired uploads are retired during
 * the same sweep, which keeps the directory — and therefore this scan — bounded.
 * Throws rather than reporting free space when the directory cannot be read; a
 * quota that fails open is not a quota.
 */
async function uploadsDirectoryUsage(
  uploadsDir: string,
  now: number,
): Promise<UploadsDirectoryUsage> {
  let entries: Array<string>;
  try {
    entries = await NodeFSP.readdir(uploadsDir);
  } catch (cause) {
    if (isMissingFileError(cause)) {
      return { totalBytes: 0, fileCount: 0 };
    }
    throw cause;
  }

  let totalBytes = 0;
  let fileCount = 0;
  for (const entry of entries) {
    const entryPath = NodePath.join(uploadsDir, entry);
    let stats;
    try {
      stats = await NodeFSP.stat(entryPath);
    } catch (cause) {
      // A file that vanished mid-sweep contributes nothing; anything else means
      // the sweep cannot account for the directory and must not report free space.
      if (isMissingFileError(cause)) continue;
      throw cause;
    }
    if (!stats.isFile()) continue;
    if (now - stats.mtimeMs > ATTACHMENT_UPLOAD_TTL_MS) {
      try {
        await NodeFSP.rm(entryPath, { force: true });
        continue;
      } catch {
        // Keep counting it if it could not be retired.
      }
    }
    totalBytes += stats.size;
    fileCount += 1;
  }
  return { totalBytes, fileCount };
}

/**
 * The extension is cosmetic — it only has to be safe and recognizable to the
 * agent that opens the file. Nothing infers a file's kind from it: uploads are
 * told apart from image attachments by their directory, not their name.
 */
export function inferUploadExtension(input: {
  readonly name: string;
  readonly mimeType: string;
}): string {
  const fromName = EXTENSION_PATTERN.exec(input.name.trim())?.[1];
  if (fromName) {
    return `.${fromName.toLowerCase()}`;
  }
  // Mime.getExtension returns a bare extension ("json"), not a dotted one.
  const fromMime = Mime.getExtension(input.mimeType);
  if (fromMime && /^[a-z0-9]{1,12}$/i.test(fromMime)) {
    return `.${fromMime.toLowerCase()}`;
  }
  return ".bin";
}

export const persistUploadedAttachment = Effect.fn("persistUploadedAttachment")(function* (input: {
  readonly attachmentsDir: string;
  readonly ownerId: string;
  readonly name: string;
  readonly dataUrl: string;
  /** Overridable so a test can fill the budget without writing 512MB. */
  readonly totalBudgetBytes?: number;
  /** Overridable so a test can age uploads past the TTL without waiting. */
  readonly now?: number;
}) {
  const totalBudgetBytes = input.totalBudgetBytes ?? ATTACHMENT_UPLOADS_TOTAL_MAX_BYTES;
  const fail = (reason: string) => new AttachmentUploadError({ name: input.name, reason });
  let failureCause: unknown = null;

  const parsed = parseBase64DataUrl(input.dataUrl);
  if (!parsed) {
    return yield* fail("the payload is not a base64 data URL.");
  }

  const bytes = Buffer.from(parsed.base64, "base64");
  if (bytes.byteLength === 0) {
    return yield* fail("the file is empty.");
  }
  if (bytes.byteLength > ATTACHMENT_UPLOAD_MAX_BYTES) {
    return yield* fail(
      `the file exceeds the ${Math.floor(ATTACHMENT_UPLOAD_MAX_BYTES / (1024 * 1024))}MB upload limit.`,
    );
  }

  const attachmentId = createAttachmentId(input.ownerId);
  if (!attachmentId) {
    return yield* fail("the owner id is not a safe attachment prefix.");
  }

  const extension = inferUploadExtension({ name: input.name, mimeType: parsed.mimeType });
  const filePath = resolveAttachmentRelativePath({
    attachmentsDir: input.attachmentsDir,
    relativePath: `${ATTACHMENT_UPLOADS_DIRECTORY}/${attachmentId}${extension}`,
  });
  if (!filePath) {
    return yield* fail("the resolved path escaped the attachments directory.");
  }

  // Owner ids cannot be authenticated — a draft has no server-side record — so the
  // uploads directory carries a total budget instead. It bounds what a client can
  // park under owners that no thread lifecycle will ever clean up.
  const uploadsDir = NodePath.dirname(filePath);
  const now = input.now ?? (yield* Clock.currentTimeMillis);
  const outcome: UploadOutcome = yield* Effect.tryPromise({
    try: () =>
      withUploadLock(async (): Promise<UploadOutcome> => {
        const usage = await uploadsDirectoryUsage(uploadsDir, now);
        if (usage.totalBytes + bytes.byteLength > totalBudgetBytes) {
          return "over-budget";
        }
        if (usage.fileCount >= ATTACHMENT_UPLOADS_MAX_FILES) {
          return "too-many-files";
        }
        await NodeFSP.mkdir(uploadsDir, { recursive: true });
        try {
          await NodeFSP.writeFile(filePath, bytes);
        } catch (cause) {
          // A partial write leaves a random-named file nothing will ever claim.
          await NodeFSP.rm(filePath, { force: true });
          throw cause;
        }
        return "written";
      }),
    catch: (cause) => {
      failureCause = cause;
      return fail("the file could not be written to disk.");
    },
  }).pipe(
    Effect.tapError(() =>
      Effect.logWarning("failed to store an uploaded attachment", {
        name: input.name,
        cause: failureCause,
      }),
    ),
  );

  if (outcome === "over-budget") {
    return yield* fail(
      `the ${Math.floor(totalBudgetBytes / (1024 * 1024))}MB upload storage budget is full; delete some threads first.`,
    );
  }
  if (outcome === "too-many-files") {
    return yield* fail(
      `the upload storage already holds ${ATTACHMENT_UPLOADS_MAX_FILES} files; delete some threads first.`,
    );
  }

  return { path: filePath };
});
