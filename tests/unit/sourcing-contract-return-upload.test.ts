import { describe, expect, it, vi } from "vitest";
import { SourcingContractReturnUploadSchema } from "../../packages/contracts/src/sourcing.js";
import { contractReturnFileError, finishContractReturnUpload } from "../../apps/web/src/sourcing-contract-return-upload.js";

describe("contract return three-file upload", () => {
  const ids = [1, 2, 3, 4].map(n => `00000000-0000-4000-8000-00000000000${n}`);
  const pdf = () => new File(["pdf"], "合同.pdf", { type: "application/pdf" });
  it("accepts one to three files and rejects zero, four, duplicate IDs, wrong type and excess combined size", () => {
    for (const count of [0, 1, 2, 3, 4]) {
      expect(SourcingContractReturnUploadSchema.safeParse({ attachmentIds: ids.slice(0, count) }).success).toBe(count >= 1 && count <= 3);
      expect(contractReturnFileError(Array.from({ length: count }, pdf)) === null).toBe(count >= 1 && count <= 3);
    }
    expect(SourcingContractReturnUploadSchema.safeParse({ attachmentIds: [ids[0], ids[0]] }).success).toBe(false);
    expect(contractReturnFileError([pdf(), new File(["png"], "附件.png", { type: "image/png" })])).toBeNull();
    expect(contractReturnFileError([{ type: "text/plain", size: 1 }])).toBeTruthy();
    expect(contractReturnFileError([{ type: "application/pdf", size: 20 * 1024 * 1024 }, { type: "application/pdf", size: 1 }])).toBeTruthy();
    expect(contractReturnFileError([pdf()], 1, 100)).toBeNull();
    expect(contractReturnFileError([pdf(), pdf()], 1)).toBeNull();
    expect(contractReturnFileError([pdf()], 2)).toBeNull();
    expect(contractReturnFileError([pdf()], 3)).toBeTruthy();
    expect(contractReturnFileError([pdf()], 1, 20 * 1024 * 1024)).toBeTruthy();
  });
  it("keeps the selected contract version through upload retries", async () => {
    const pending={files:[pdf()],attachmentIds:[] as string[],key:"version-key",expectedContractDocumentId:ids[2]};
    const upload=vi.fn().mockResolvedValue(ids[0]);
    expect(await finishContractReturnUpload(pending,upload)).toEqual({attachmentIds:[ids[0]],key:"version-key",expectedContractDocumentId:ids[2]});
    expect(contractReturnFileError([pdf(),pdf()],0,0)).toBeNull();
    expect(contractReturnFileError([pdf()],3,128)).toContain("当前合同版本");
  });
  it("retains the first two ready files, retries only the failed third file and returns one stable submission", async () => {
    const pending = { files: [pdf(), pdf(), pdf()], attachmentIds: [] as string[], key: "stable-key" };
    const upload = vi.fn().mockResolvedValueOnce(ids[0]).mockResolvedValueOnce(ids[1]).mockRejectedValueOnce(new Error("third failed")).mockResolvedValueOnce(ids[2]);
    await expect(finishContractReturnUpload(pending, upload)).rejects.toThrow("third failed");
    expect(pending.attachmentIds).toEqual(ids.slice(0, 2));
    expect(await finishContractReturnUpload(pending, upload)).toEqual({ attachmentIds: ids.slice(0, 3), key: "stable-key" });
    expect(upload).toHaveBeenCalledTimes(4);
    expect(await finishContractReturnUpload(pending, upload)).toEqual({ attachmentIds: ids.slice(0, 3), key: "stable-key" });
    expect(upload).toHaveBeenCalledTimes(4);
  });
});
