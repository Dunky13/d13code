// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { AttachmentUploadInput } from "@t3tools/contracts";
import { afterAll, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { isPrunableAttachmentRelativePath } from "./attachmentStore.ts";
import { inferUploadExtension, persistUploadedAttachment } from "./attachmentUpload.ts";

const createdDirs: string[] = [];

function makeAttachmentsDir(): string {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-attachment-upload-"));
  createdDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of createdDirs) {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
});

function dataUrl(mimeType: string, contents: string): string {
  return `data:${mimeType};base64,${Buffer.from(contents, "utf8").toString("base64")}`;
}

describe("AttachmentUploadInput", () => {
  const decode = Schema.decodeUnknownSync(AttachmentUploadInput);
  const payload = {
    ownerId: "0e70cccb-51e2-49af-a022-146fbaeede55",
    name: "server.log",
    dataUrl: "data:text/plain;base64,Ym9vbQ==",
  };

  it("accepts thread and draft uuids", () => {
    expect(decode(payload).ownerId).toBe(payload.ownerId);
  });

  it("rejects fabricated owners that no thread lifecycle would clean up", () => {
    expect(() => decode({ ...payload, ownerId: "spam-bucket" })).toThrow();
    expect(() => decode({ ...payload, ownerId: "../../etc" })).toThrow();
  });
});

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

  it.effect("stores under the owner id so thread cleanup can find it later", () =>
    Effect.gen(function* () {
      const attachmentsDir = makeAttachmentsDir();
      const ownerId = "0e70cccb-51e2-49af-a022-146fbaeede55";
      const result = yield* persistUploadedAttachment({
        attachmentsDir,
        ownerId,
        name: "server.log",
        dataUrl: dataUrl("text/plain", "boom"),
      });

      expect(NodePath.basename(result.path).startsWith(ownerId)).toBe(true);
      // Uploads are not structured attachments, so revert pruning must skip them.
      expect(isPrunableAttachmentRelativePath(NodePath.basename(result.path))).toBe(false);
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
