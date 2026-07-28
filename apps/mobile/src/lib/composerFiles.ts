import { ATTACHMENT_UPLOAD_MAX_BYTES } from "@t3tools/contracts";

import { estimateBase64ByteSize } from "./base64";

const UPLOAD_SIZE_LIMIT_LABEL = `${Math.round(ATTACHMENT_UPLOAD_MAX_BYTES / (1024 * 1024))} MB`;

export interface PickedComposerFile {
  readonly name: string;
  readonly dataUrl: string;
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
 * Non-image files are uploaded and handed to the agent as a path, so they are
 * read as base64 here and never staged as chat attachments.
 */
export async function pickComposerFiles(): Promise<{
  readonly files: ReadonlyArray<PickedComposerFile>;
  readonly error: string | null;
}> {
  let documentPicker: Awaited<ReturnType<typeof loadDocumentPicker>>;
  let fileSystem: Awaited<ReturnType<typeof loadFileSystem>>;
  try {
    documentPicker = await loadDocumentPicker();
    fileSystem = await loadFileSystem();
  } catch (error) {
    return {
      files: [],
      error: error instanceof Error ? error.message : "File attachments are unavailable right now.",
    };
  }

  const result = await documentPicker.getDocumentAsync({
    multiple: true,
    copyToCacheDirectory: true,
  });
  if (result.canceled) {
    return { files: [], error: null };
  }

  const files: PickedComposerFile[] = [];
  let error: string | null = null;

  for (const asset of result.assets) {
    const name = asset.name || "file";
    if (asset.size !== undefined && asset.size > ATTACHMENT_UPLOAD_MAX_BYTES) {
      error = `'${name}' exceeds the ${UPLOAD_SIZE_LIMIT_LABEL} upload limit.`;
      continue;
    }
    let base64: string;
    try {
      base64 = await new fileSystem.File(asset.uri).base64();
    } catch {
      error = `Failed to read '${name}'.`;
      continue;
    }
    const sizeBytes = estimateBase64ByteSize(base64);
    if (sizeBytes <= 0) {
      error = `'${name}' is empty.`;
      continue;
    }
    if (sizeBytes > ATTACHMENT_UPLOAD_MAX_BYTES) {
      error = `'${name}' exceeds the ${UPLOAD_SIZE_LIMIT_LABEL} upload limit.`;
      continue;
    }
    files.push({
      name,
      dataUrl: `data:${asset.mimeType ?? "application/octet-stream"};base64,${base64}`,
    });
  }

  return { files, error };
}
