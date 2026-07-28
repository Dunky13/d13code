import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  ClipboardApiUnavailableError,
  ClipboardWriteError,
  writeTextToClipboard,
} from "./useCopyToClipboard";

/**
 * Minimal DOM stand-in for the insecure-context `execCommand("copy")` path: the
 * web unit project runs without a DOM environment, and `execCommand` copies
 * whatever the current selection covers, so the stub tracks the selected node.
 */
function stubExecCommandDocument(): { copied: string[] } {
  const copied: string[] = [];
  const selectedText: string[] = [];
  vi.stubGlobal("document", {
    body: { appendChild: () => {} },
    createElement: () => ({ textContent: "", style: {}, setAttribute: () => {}, remove: () => {} }),
    createRange: () => ({
      selectNodeContents: (node: { textContent: string }) => {
        selectedText.push(node.textContent);
      },
    }),
    getSelection: () => ({ rangeCount: 0, removeAllRanges: () => {}, addRange: () => {} }),
    execCommand: (command: string) => {
      const text = selectedText.at(-1);
      if (command !== "copy" || text === undefined) return false;
      copied.push(text);
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
