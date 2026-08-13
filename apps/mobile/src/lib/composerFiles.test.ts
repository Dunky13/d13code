import { describe, expect, it } from "vite-plus/test";

import { resolveComposerFileMimeType } from "./composerFiles";

describe("resolveComposerFileMimeType", () => {
  it("keeps the mime type the picker reported", () => {
    expect(resolveComposerFileMimeType({ name: "server.log", mimeType: "text/plain" })).toBe(
      "text/plain",
    );
  });

  it("recovers an image type when the picker reports nothing useful", () => {
    expect(resolveComposerFileMimeType({ name: "shot.PNG", mimeType: undefined })).toBe(
      "image/png",
    );
    expect(
      resolveComposerFileMimeType({ name: "photo.jpg", mimeType: "application/octet-stream" }),
    ).toBe("image/jpeg");
  });

  it("leaves non-image files as documents", () => {
    expect(resolveComposerFileMimeType({ name: "trace", mimeType: undefined })).toBe(
      "application/octet-stream",
    );
    expect(resolveComposerFileMimeType({ name: "notes.md", mimeType: undefined })).toBe(
      "application/octet-stream",
    );
  });
});
