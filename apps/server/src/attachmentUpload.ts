// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import Mime from "@effect/platform-node/Mime";
import { ATTACHMENT_UPLOAD_MAX_BYTES, AttachmentUploadError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { resolveAttachmentRelativePath } from "./attachmentPaths.ts";
import { ATTACHMENT_UPLOADS_DIRECTORY, createAttachmentId } from "./attachmentStore.ts";
import { parseBase64DataUrl } from "./imageMime.ts";

const EXTENSION_PATTERN = /\.([a-z0-9]{1,12})$/i;

/** Total budget for uploaded documents that are not tied to a live thread yet. */
export const ATTACHMENT_UPLOADS_TOTAL_MAX_BYTES = 512 * 1024 * 1024;

async function uploadsDirectoryBytes(uploadsDir: string): Promise<number> {
  let entries: Array<import("node:fs").Dirent>;
  try {
    entries = await NodeFSP.readdir(uploadsDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let total = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    try {
      const stats = await NodeFSP.stat(NodePath.join(uploadsDir, entry.name));
      total += stats.size;
    } catch {
      // A file that vanished mid-sweep contributes nothing.
    }
  }
  return total;
}

/**
 * Uploaded non-image files are stored as `<attachmentId><ext>` so the existing
 * thread-scoped attachment cleanup keeps working; the extension only has to be
 * safe and recognizable to the agent that reads the file.
 */
export function inferUploadExtension(input: {
  readonly name: string;
  readonly mimeType: string;
}): string {
  const fromName = EXTENSION_PATTERN.exec(input.name.trim());
  if (fromName) {
    return `.${fromName[1]!.toLowerCase()}`;
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
}) {
  const fail = (reason: string) => new AttachmentUploadError({ name: input.name, reason });

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
  const usedBytes = yield* Effect.promise(() => uploadsDirectoryBytes(uploadsDir));
  if (usedBytes + bytes.byteLength > ATTACHMENT_UPLOADS_TOTAL_MAX_BYTES) {
    return yield* fail(
      `the ${Math.floor(ATTACHMENT_UPLOADS_TOTAL_MAX_BYTES / (1024 * 1024))}MB upload storage budget is full; delete some threads first.`,
    );
  }

  yield* Effect.tryPromise({
    try: async () => {
      await NodeFSP.mkdir(uploadsDir, { recursive: true });
      try {
        await NodeFSP.writeFile(filePath, bytes);
      } catch (cause) {
        // A partial write leaves a random-named file nothing will ever claim.
        await NodeFSP.rm(filePath, { force: true });
        throw cause;
      }
    },
    catch: () => fail("the file could not be written to disk."),
  });

  return { path: filePath };
});
