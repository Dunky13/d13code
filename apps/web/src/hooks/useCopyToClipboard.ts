import * as React from "react";
import * as Schema from "effect/Schema";

export class ClipboardApiUnavailableError extends Schema.TaggedErrorClass<ClipboardApiUnavailableError>()(
  "ClipboardApiUnavailableError",
  {
    target: Schema.String,
  },
) {
  override get message(): string {
    return `Clipboard API is unavailable while copying ${this.target}.`;
  }
}

export class ClipboardWriteError extends Schema.TaggedErrorClass<ClipboardWriteError>()(
  "ClipboardWriteError",
  {
    target: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to copy ${this.target} to the clipboard.`;
  }
}

/**
 * `navigator.clipboard` only exists in secure contexts, so a phone or another
 * machine hitting the dev/remote server over plain http has no async clipboard
 * at all. The deprecated `execCommand("copy")` copies the document selection,
 * which still works there.
 *
 * The text goes into a plain (non-editable) node rather than a textarea: an
 * editable field has to be focused to be selected, and focusing one on iOS pops
 * the software keyboard and steals focus from the composer. `white-space: pre`
 * keeps newlines and indentation in the copied text.
 *
 * Only reliable inside the user gesture, so callers must reach it without an
 * `await` in front — see `writeTextToClipboard`.
 */
function copyViaExecCommand(value: string): boolean {
  if (typeof document === "undefined" || typeof document.execCommand !== "function") return false;

  const holder = document.createElement("pre");
  holder.textContent = value;
  holder.setAttribute("aria-hidden", "true");
  holder.style.position = "fixed";
  holder.style.top = "0";
  holder.style.left = "0";
  holder.style.opacity = "0";
  holder.style.pointerEvents = "none";
  holder.style.whiteSpace = "pre";
  holder.style.userSelect = "text";
  holder.style.webkitUserSelect = "text";
  document.body.appendChild(holder);

  const selection = document.getSelection();
  const previousRanges = selection
    ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index))
    : [];
  try {
    const range = document.createRange();
    range.selectNodeContents(holder);
    selection?.removeAllRanges();
    selection?.addRange(range);
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    holder.remove();
    selection?.removeAllRanges();
    // Copying must not eat the user's own text selection.
    for (const range of previousRanges) selection?.addRange(range);
  }
}

/**
 * Whether a copy can be attempted at all — either clipboard path counts, so an
 * insecure context (phone/remote over http) still qualifies via the fallback.
 * For gating UI only; a copy can still fail once attempted.
 */
export function canWriteToClipboard(): boolean {
  if (typeof window === "undefined" || typeof navigator === "undefined") return false;
  return (
    navigator.clipboard?.writeText != null ||
    (typeof document !== "undefined" && typeof document.execCommand === "function")
  );
}

export async function writeTextToClipboard(value: string, target = "text") {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    throw new ClipboardApiUnavailableError({
      target,
    });
  }

  if (!value) return false;

  if (!navigator.clipboard?.writeText) {
    if (copyViaExecCommand(value)) return true;
    throw new ClipboardApiUnavailableError({
      target,
    });
  }

  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch (cause) {
    // Best-effort only: the gesture may already have been spent by the await,
    // in which case the browser refuses this too and we surface the real error.
    if (copyViaExecCommand(value)) return true;
    throw new ClipboardWriteError({
      target,
      cause,
    });
  }
}

export function useCopyToClipboard<TContext = void>({
  timeout = 2000,
  target = "text",
  onCopy,
  onError,
}: {
  timeout?: number;
  target?: string;
  onCopy?: (ctx: TContext) => void;
  onError?: (error: Error, ctx: TContext) => void;
} = {}): { copyToClipboard: (value: string, ctx: TContext) => void; isCopied: boolean } {
  const [isCopied, setIsCopied] = React.useState(false);
  const timeoutIdRef = React.useRef<NodeJS.Timeout | null>(null);
  const onCopyRef = React.useRef(onCopy);
  const onErrorRef = React.useRef(onError);
  const targetRef = React.useRef(target);
  const timeoutRef = React.useRef(timeout);

  onCopyRef.current = onCopy;
  onErrorRef.current = onError;
  targetRef.current = target;
  timeoutRef.current = timeout;

  const copyToClipboard = React.useCallback((value: string, ctx: TContext): void => {
    void writeTextToClipboard(value, targetRef.current).then(
      (didCopy) => {
        if (!didCopy) return;
        if (timeoutIdRef.current) {
          clearTimeout(timeoutIdRef.current);
        }
        setIsCopied(true);

        onCopyRef.current?.(ctx);

        if (timeoutRef.current !== 0) {
          timeoutIdRef.current = setTimeout(() => {
            setIsCopied(false);
            timeoutIdRef.current = null;
          }, timeoutRef.current);
        }
      },
      (error) => {
        console.error(error);
        onErrorRef.current?.(error, ctx);
      },
    );
  }, []);

  // Cleanup timeout on unmount
  React.useEffect(() => {
    return (): void => {
      if (timeoutIdRef.current) {
        clearTimeout(timeoutIdRef.current);
      }
    };
  }, []);

  return { copyToClipboard, isCopied };
}
