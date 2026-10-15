import { hasInvalidDeclaredImageError, normalizeOriginalImageForUpload } from "./attachment-upload.js";

export function patternMaterialMime(bytes: Uint8Array): string | null {
  const starts = (prefix: number[]) => prefix.every((value, index) => bytes[index] === value);
  if (starts([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (starts([137, 80, 78, 71, 13, 10, 26, 10])) return "image/png";
  if (starts([82, 73, 70, 70]) && [87, 69, 66, 80].every((value, index) => bytes[index + 8] === value)) return "image/webp";
  if (starts([37, 80, 68, 70, 45])) return "application/pdf";
  return null;
}

/** Correct metadata from the bytes before hashing; supported originals stay byte-for-byte intact. */
export async function preparePatternMaterial(file: File, maxBytes = 20 * 1024 * 1024): Promise<File> {
  if (!file.size) throw new Error("文件为空，请重新选择");
  const mimeType = patternMaterialMime(new Uint8Array(await file.slice(0, 12).arrayBuffer()));
  if (!mimeType) {
    if (file.type.startsWith("image/")) return normalizeOriginalImageForUpload(file, maxBytes);
    throw new Error("请选择可读取的 JPG、PNG、WebP 图片或 PDF");
  }
  if (file.size > maxBytes) throw new Error(`文件超过 ${Math.floor(maxBytes / 1024 / 1024)} MB 上传上限`);
  const extension = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "application/pdf": "pdf" }[mimeType];
  const matches = mimeType === "image/jpeg" ? /\.jpe?g$/i.test(file.name) : file.name.toLowerCase().endsWith(`.${extension}`);
  const filename = matches ? file.name : `${file.name.replace(/\.[^.]+$/, "") || "制作资料"}.${extension}`;
  return mimeType === file.type && filename === file.name ? file : new File([file], filename, { type: mimeType, lastModified: file.lastModified });
}

export async function uploadPatternMaterial<T>(file: File, upload: (prepared: File) => Promise<T>, maxBytes = 20 * 1024 * 1024): Promise<T> {
  const prepared = await preparePatternMaterial(file, maxBytes);
  try {
    return await upload(prepared);
  } catch (error) {
    if (!hasInvalidDeclaredImageError(error)) throw error;
    if (prepared.type === "application/pdf") throw new Error("PDF 内容无法读取，请重新导出后上传");
    // Some phone-saved images decode successfully but fail strict container validation.
    // Retry once at full resolution within the configured cap, retaining server validation.
    try {
      return await upload(await normalizeOriginalImageForUpload(prepared, maxBytes));
    } catch (retryError) {
      if (hasInvalidDeclaredImageError(retryError)) throw new Error("图片内容无法读取，请重新保存图片后上传");
      throw retryError;
    }
  }
}
