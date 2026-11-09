export type ContractReturnUpload = {
  files: File[];
  attachmentIds: string[];
  key: string;
  expectedContractDocumentId?: string | null;
};

export function contractReturnFileError(files: readonly Pick<File, "type" | "size">[], existingCount = 0, existingBytes = 0): string | null {
  return files.length < 1 || files.length + existingCount > 3
    || files.some(file => !["application/pdf", "image/jpeg", "image/png"].includes(file.type))
    || existingBytes + files.reduce((size, file) => size + file.size, 0) > 20 * 1024 * 1024
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
