export type ContractReturnUpload = {
  files: File[];
  attachmentIds: string[];
  key: string;
};

export function contractReturnFileError(files: readonly Pick<File, "type" | "size">[]): string | null {
  return files.length < 1 || files.length > 2
    || files.some(file => !["application/pdf", "image/jpeg", "image/png"].includes(file.type))
    || files.reduce((size, file) => size + file.size, 0) > 20 * 1024 * 1024
    ? "请选择 1 至 2 个 PDF/JPG/PNG 文件，合计不超过 20 MB" : null;
}

// Keep ready uploads during a partial failure. Submit the business event only after all files are ready.
export async function finishContractReturnUpload(
  pending: ContractReturnUpload,
  upload: (file: File) => Promise<string>,
): Promise<{ attachmentIds: string[]; key: string }> {
  while (pending.attachmentIds.length < pending.files.length) {
    const file = pending.files[pending.attachmentIds.length]!;
    pending.attachmentIds.push(await upload(file));
  }
  return { attachmentIds: [...pending.attachmentIds], key: pending.key };
}
