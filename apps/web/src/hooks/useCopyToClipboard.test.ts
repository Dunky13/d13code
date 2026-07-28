import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  ClipboardApiUnavailableError,
  ClipboardWriteError,
  writeTextToClipboard,
} from "./useCopyToClipboard";

/** Minimal DOM stand-in for the insecure-context `execCommand("copy")` path. */
function stubExecCommandDocument(): { copied: string[] } {
  const copied: string[] = [];
  const textarea = {
    value: "",
    contentEditable: "",
    readOnly: false,
    style: {} as Record<string, string>,
    setAttribute: () => {},
    focus: () => {},
    setSelectionRange: () => {},
    remove: () => {},
  };
  vi.stubGlobal("document", {
    activeElement: null,
    body: { appendChild: () => {} },
    createElement: () => textarea,
    createRange: () => ({ selectNodeContents: () => {} }),
    getSelection: () => ({ rangeCount: 0, removeAllRanges: () => {}, addRange: () => {} }),
    execCommand: (command: string) => {
      if (command !== "copy") return false;
      copied.push(textarea.value);
      return true;
    },
  });
  return { copied };
}

describe("writeTextToClipboard", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("falls back to execCommand when the async clipboard is missing", async () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", {});
    const { copied } = stubExecCommandDocument();

    await expect(writeTextToClipboard("pnpm dev", "code block")).resolves.toBe(true);
    expect(copied).toEqual(["pnpm dev"]);
  });

  it("falls back to execCommand when the async clipboard write rejects", async () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error()) },
    });
    const { copied } = stubExecCommandDocument();

    await expect(writeTextToClipboard("pnpm dev", "code block")).resolves.toBe(true);
    expect(copied).toEqual(["pnpm dev"]);
  });

  it("reports unavailable clipboard support with structural context", async () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", {});

    const error = await writeTextToClipboard("plan contents", "plan").then(
      () => undefined,
      (cause: unknown) => cause,
    );

    expect(error).toBeInstanceOf(ClipboardApiUnavailableError);
    expect(error).toMatchObject({
      target: "plan",
    });
    expect((error as Error).message).not.toContain("plan contents");
  });

  it("preserves the exact clipboard failure without exposing copied contents", async () => {
    const cause = new Error("browser clipboard failure");
    const writeText = vi.fn().mockRejectedValue(cause);
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    const error = await writeTextToClipboard("secret clipboard contents", "error-message").then(
      () => undefined,
      (failure: unknown) => failure,
    );

    expect(writeText).toHaveBeenCalledWith("secret clipboard contents");
    expect(error).toBeInstanceOf(ClipboardWriteError);
    expect(error).toMatchObject({
      target: "error-message",
      cause,
    });
    expect((error as Error).message).not.toContain("secret clipboard contents");
  });

  it("keeps empty values as a no-op when clipboard support is available", async () => {
    const writeText = vi.fn();
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    await expect(writeTextToClipboard("", "plan")).resolves.toBe(false);
    expect(writeText).not.toHaveBeenCalled();
  });
});
