import type { SourcingContractReturnResponse } from "@dx-rework/contracts";

export type ContractReturnUpload = {
  files: File[];
  attachmentIds: string[];
  key: string;
  expectedContractDocumentId?: string | null;
};

export const CONTRACT_RETURN_MAX_FILES = 3;
export const CONTRACT_RETURN_MAX_BYTES = 20 * 1024 * 1024;
const CONTRACT_RETURN_MIME_TYPES = ["application/pdf", "image/jpeg", "image/png"];

export function formatContractReturnSize(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

// Give the user the exact reason before starting any upload request.
// Keep the same limits as the server and the existing generic validator.
export function contractReturnSelectionError(
  files: readonly Pick<File, "type" | "size" | "name">[], existingCount = 0, existingBytes = 0,
): string | null {
  if (!files.length) return "本次未上传：请选择 PDF/JPG/PNG 文件。";
  if (existingCount + files.length > CONTRACT_RETURN_MAX_FILES) {
    return `本次未上传：当前已保存 ${existingCount} 份，本次选择 ${files.length} 份，`
      + `每个合同版本最多保存 ${CONTRACT_RETURN_MAX_FILES} 份。原有文件不受影响。`;
  }
  const invalid = files.find(file => !CONTRACT_RETURN_MIME_TYPES.includes(file.type));
  if (invalid) {
    return `本次未上传：《${invalid.name}》的格式不支持，仅允许 PDF/JPG/PNG。原有文件不受影响。`;
  }
  const selectedBytes = files.reduce((total, file) => total + file.size, 0);
  if (existingBytes + selectedBytes > CONTRACT_RETURN_MAX_BYTES) {
    const excessBytes = existingBytes + selectedBytes - CONTRACT_RETURN_MAX_BYTES;
    const excess = excessBytes < 1024 * 1024 / 100
      ? `${excessBytes} 字节` : formatContractReturnSize(excessBytes);
    const selected = files.length === 1
      ? `《${files[0]!.name}》大小为 ${formatContractReturnSize(selectedBytes)}`
      : `所选 ${files.length} 份文件合计 ${formatContractReturnSize(selectedBytes)}`;
    return `本次未上传：${selected}，当前合同版本仅剩 `
      + `${formatContractReturnSize(Math.max(0, CONTRACT_RETURN_MAX_BYTES - existingBytes))} 可用空间，超出额度 ${excess}。`
      + `原有 ${existingCount} 份文件不受影响。`;
  }
  return null;
}

// The response must contain every new attachment before announcing a successful save.
export function confirmedContractReturnFiles(
  attachments: readonly { attachmentId: string; filename: string }[], attachmentIds: readonly string[],
): string[] | null {
  const names = new Map<string, string>(attachments.map(file => [file.attachmentId, file.filename]));
  return attachmentIds.length && attachmentIds.every(id => names.has(id))
    ? attachmentIds.map(id => names.get(id)!) : null;
}
export function confirmedContractReturnVersionFiles(
  value: Pick<SourcingContractReturnResponse, "signedContractDocumentId" | "attachments" | "history">,
  attachmentIds: readonly string[], expectedContractDocumentId: string | null,
): string[] | null {
  const signed = value.signedContractDocumentId === expectedContractDocumentId ? value.attachments : [];
  const history = value.history.filter(row => row.signedContractDocumentId === expectedContractDocumentId).flatMap(row => row.attachments);
  return confirmedContractReturnFiles([...history, ...signed], attachmentIds);
}

// A failed HTTP response may still follow a committed business write. Read back
// the exact attachment IDs before permitting another save attempt with the same key.
export async function confirmContractReturnSubmission<T extends {
  attachments: readonly { attachmentId: string; filename: string }[];
}>(attachmentIds: readonly string[], submit: () => Promise<T>, read: () => Promise<T>,
  confirms: (value: T) => boolean = value => confirmedContractReturnFiles(value.attachments, attachmentIds) !== null,
): Promise<T> {
  let submitted: T;
  try {
    submitted = await submit();
  } catch (error) {
    try {
      const current = await read();
      if (confirms(current)) return current;
    } catch { /* Preserve the original write error when readback also fails. */ }
    throw error;
  }
  if (confirms(submitted)) return submitted;
  try {
    const current = await read();
    if (confirms(current)) return current;
  } catch { /* An incomplete response cannot prove rejection either. */ }
  throw new Error("合同回签保存结果尚未确认，请使用原请求重试保存。");
}

export function contractReturnFileError(files: readonly Pick<File, "type" | "size">[], existingCount = 0, existingBytes = 0): string | null {
  return files.length < 1 || files.length + existingCount > CONTRACT_RETURN_MAX_FILES
    || files.some(file => !CONTRACT_RETURN_MIME_TYPES.includes(file.type))
    || existingBytes + files.reduce((size, file) => size + file.size, 0) > CONTRACT_RETURN_MAX_BYTES
    ? "当前合同版本回签文件累计最多 3 个 PDF/JPG/PNG，合计不超过 20 MB" : null;
}

// Keep ready uploads during a partial failure. Submit the business event only after all files are ready.
export async function finishContractReturnUpload(
  pending: ContractReturnUpload,
  upload: (file: File) => Promise<string>,
): Promise<{ attachmentIds: string[]; key: string; expectedContractDocumentId?: string | null }> {
  while (pending.attachmentIds.length < pending.files.length) {
    const file = pending.files[pending.attachmentIds.length]!;
    pending.attachmentIds.push(await upload(file));
  }
  return { attachmentIds: [...pending.attachmentIds], key: pending.key,
    ...(pending.expectedContractDocumentId !== undefined ? { expectedContractDocumentId: pending.expectedContractDocumentId } : {}) };
}
