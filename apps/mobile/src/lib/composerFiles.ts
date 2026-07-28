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
      mimeType: asset.mimeType ?? "application/octet-stream",
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
