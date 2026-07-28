import {
  ATTACHMENT_UPLOAD_MAX_BYTES,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
} from "@t3tools/contracts";

import { estimateBase64ByteSize } from "./base64";

const UPLOAD_SIZE_LIMIT_LABEL = `${Math.round(ATTACHMENT_UPLOAD_MAX_BYTES / (1024 * 1024))} MB`;

export interface PickedComposerFile {
  readonly name: string;
  readonly uri: string;
  readonly mimeType: string;
}

export interface ReadComposerFile {
  readonly name: string;
  readonly mimeType: string;
  readonly dataUrl: string;
  readonly sizeBytes: number;
}

const IMAGE_EXTENSION_MIME_TYPES: Record<string, string> = {
  avif: "image/avif",
  bmp: "image/bmp",
  gif: "image/gif",
  heic: "image/heic",
  heif: "image/heif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  tif: "image/tiff",
  tiff: "image/tiff",
  webp: "image/webp",
};

/**
 * Document pickers hand back optional MIME metadata; Android in particular can
 * return `application/octet-stream` for a photo. Falling back to the extension
 * keeps images on the attachment pipeline instead of the path handoff.
 */
export function resolveComposerFileMimeType(input: {
  readonly name: string;
  readonly mimeType: string | undefined;
}): string {
  const mimeType = input.mimeType?.toLowerCase() ?? "";
  if (mimeType.length > 0 && mimeType !== "application/octet-stream") {
    return mimeType;
  }
  const extension = /\.([a-z0-9]+)$/i.exec(input.name.trim())?.[1]?.toLowerCase();
  const imageMimeType = extension ? IMAGE_EXTENSION_MIME_TYPES[extension] : undefined;
  if (imageMimeType) {
    return imageMimeType;
  }
  return mimeType.length > 0 ? mimeType : "application/octet-stream";
}

async function loadDocumentPicker() {
  try {
    return await import("expo-document-picker");
  } catch (error) {
    throw new Error("File attachments are unavailable right now.", { cause: error });
  }
}

async function loadFileSystem() {
  try {
    return await import("expo-file-system");
  } catch (error) {
    throw new Error("File attachments are unavailable right now.", { cause: error });
  }
}

/**
 * Picks file references only. Payloads are read one at a time by the caller so a
 * multi-select never holds several base64 blobs in memory at once.
 */
export async function pickComposerFiles(): Promise<{
  readonly files: ReadonlyArray<PickedComposerFile>;
  readonly error: string | null;
}> {
  let documentPicker: Awaited<ReturnType<typeof loadDocumentPicker>>;
  try {
    documentPicker = await loadDocumentPicker();
  } catch (error) {
    return {
      files: [],
      error: error instanceof Error ? error.message : "File attachments are unavailable right now.",
    };
  }

  let result: Awaited<ReturnType<typeof documentPicker.getDocumentAsync>>;
  try {
    result = await documentPicker.getDocumentAsync({
      multiple: true,
      copyToCacheDirectory: true,
    });
  } catch {
    return { files: [], error: "The file picker could not be opened." };
  }
  if (result.canceled) {
    return { files: [], error: null };
  }

  const files: PickedComposerFile[] = [];
  let error: string | null = null;

  for (const asset of result.assets) {
    const name = asset.name || "file";
    if (files.length >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
      error = `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} files at a time.`;
      break;
    }
    if (asset.size !== undefined && asset.size > ATTACHMENT_UPLOAD_MAX_BYTES) {
      error = `'${name}' exceeds the ${UPLOAD_SIZE_LIMIT_LABEL} upload limit.`;
      continue;
    }
    files.push({
      name,
      uri: asset.uri,
      mimeType: resolveComposerFileMimeType({ name, mimeType: asset.mimeType }),
    });
  }

  return { files, error };
}

export async function readComposerFile(
  file: PickedComposerFile,
): Promise<{ readonly file: ReadComposerFile | null; readonly error: string | null }> {
  let fileSystem: Awaited<ReturnType<typeof loadFileSystem>>;
  try {
    fileSystem = await loadFileSystem();
  } catch (error) {
    return {
      file: null,
      error: error instanceof Error ? error.message : "File attachments are unavailable right now.",
    };
  }

  let base64: string;
  try {
    base64 = await new fileSystem.File(file.uri).base64();
  } catch {
    return { file: null, error: `Failed to read '${file.name}'.` };
  }

  const sizeBytes = estimateBase64ByteSize(base64);
  if (sizeBytes <= 0) {
    return { file: null, error: `'${file.name}' is empty.` };
  }
  if (sizeBytes > ATTACHMENT_UPLOAD_MAX_BYTES) {
    return {
      file: null,
      error: `'${file.name}' exceeds the ${UPLOAD_SIZE_LIMIT_LABEL} upload limit.`,
    };
  }

  return {
    file: {
      name: file.name,
      mimeType: file.mimeType,
      sizeBytes,
      dataUrl: `data:${file.mimeType};base64,${base64}`,
    },
    error: null,
  };
}
