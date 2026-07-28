// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { inferUploadExtension, persistUploadedAttachment } from "./attachmentUpload.ts";

function makeAttachmentsDir(): string {
  return NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-attachment-upload-"));
}

function dataUrl(mimeType: string, contents: string): string {
  return `data:${mimeType};base64,${Buffer.from(contents, "utf8").toString("base64")}`;
}

describe("inferUploadExtension", () => {
  it("prefers the extension carried by the file name", () => {
    expect(inferUploadExtension({ name: "server.log", mimeType: "text/plain" })).toBe(".log");
    expect(inferUploadExtension({ name: "Trace.TXT", mimeType: "text/plain" })).toBe(".txt");
  });

  it("falls back to the mime type and then to .bin", () => {
    expect(inferUploadExtension({ name: "dump", mimeType: "application/json" })).toBe(".json");
    expect(inferUploadExtension({ name: "dump", mimeType: "application/x-unknown-type" })).toBe(
      ".bin",
    );
  });

  it("resolves an extensionless traversal-shaped name through the mime type", () => {
    expect(inferUploadExtension({ name: "../../etc/passwd", mimeType: "text/plain" })).toBe(".txt");
  });
});

describe("persistUploadedAttachment", () => {
  it.effect("writes the file inside the attachments dir and returns its path", () =>
    Effect.gen(function* () {
      const attachmentsDir = makeAttachmentsDir();
      const result = yield* persistUploadedAttachment({
        attachmentsDir,
        ownerId: "thr_01",
        name: "server.log",
        dataUrl: dataUrl("text/plain", "boom\n"),
      });

      expect(result.path.startsWith(`${NodePath.resolve(attachmentsDir)}${NodePath.sep}`)).toBe(
        true,
      );
      expect(result.path.endsWith(".log")).toBe(true);
      expect(NodeFS.readFileSync(result.path, "utf8")).toBe("boom\n");
    }),
  );

  it.effect("keeps a traversal-shaped file name inside the attachments dir", () =>
    Effect.gen(function* () {
      const attachmentsDir = makeAttachmentsDir();
      const result = yield* persistUploadedAttachment({
        attachmentsDir,
        ownerId: "thr_01",
        name: "../../../../etc/passwd.log",
        dataUrl: dataUrl("text/plain", "nope"),
      });

      expect(NodePath.dirname(result.path)).toBe(NodePath.resolve(attachmentsDir));
    }),
  );

  it.effect("rejects payloads that are not base64 data URLs", () =>
    Effect.gen(function* () {
      const attachmentsDir = makeAttachmentsDir();
      const failure = yield* Effect.flip(
        persistUploadedAttachment({
          attachmentsDir,
          ownerId: "thr_01",
          name: "server.log",
          dataUrl: "https://example.com/server.log",
        }),
      );

      expect(failure._tag).toBe("AttachmentUploadError");
      expect(NodeFS.readdirSync(attachmentsDir)).toEqual([]);
    }),
  );

  it.effect("rejects empty files", () =>
    Effect.gen(function* () {
      const attachmentsDir = makeAttachmentsDir();
      const failure = yield* Effect.flip(
        persistUploadedAttachment({
          attachmentsDir,
          ownerId: "thr_01",
          name: "empty.log",
          dataUrl: dataUrl("text/plain", ""),
        }),
      );

      expect(failure._tag).toBe("AttachmentUploadError");
      expect(NodeFS.readdirSync(attachmentsDir)).toEqual([]);
    }),
  );
});
