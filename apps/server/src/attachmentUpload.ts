// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import Mime from "@effect/platform-node/Mime";
import { ATTACHMENT_UPLOAD_MAX_BYTES, AttachmentUploadError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { resolveAttachmentRelativePath } from "./attachmentPaths.ts";
import { createAttachmentId } from "./attachmentStore.ts";
import { parseBase64DataUrl } from "./imageMime.ts";

const EXTENSION_PATTERN = /\.([a-z0-9]{1,12})$/i;

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

  const filePath = resolveAttachmentRelativePath({
    attachmentsDir: input.attachmentsDir,
    relativePath: `${attachmentId}${inferUploadExtension({ name: input.name, mimeType: parsed.mimeType })}`,
  });
  if (!filePath) {
    return yield* fail("the resolved path escaped the attachments directory.");
  }

  yield* Effect.tryPromise({
    try: async () => {
      await NodeFSP.mkdir(NodePath.dirname(filePath), { recursive: true });
      try {
        await NodeFSP.writeFile(filePath, bytes);
      } catch (cause) {
        // A partial write leaves a random-named file nothing will ever claim.
        await NodeFSP.rm(filePath, { force: true }).catch(() => {});
        throw cause;
      }
    },
    catch: () => fail("the file could not be written to disk."),
  });

  return { path: filePath };
});
