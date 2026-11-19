import { describe, expect, it, vi } from "vitest";
import { SourcingContractReturnUploadSchema } from "../../packages/contracts/src/sourcing.js";
import { CONTRACT_RETURN_MAX_BYTES, confirmedContractReturnFiles, confirmedContractReturnVersionFiles, confirmContractReturnSubmission, contractReturnFileError, contractReturnSelectionError, finishContractReturnUpload, formatContractReturnSize, isContractReturnVersionConflict } from "../../apps/web/src/sourcing-contract-return-upload.js";
import { SubmissionRequestError } from "../../apps/web/src/submission-validation.js";

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
  it("explains the exact remaining capacity, rejects one extra byte and does not alter saved files", () => {
    const existingBytes=10_968_861;
    const remaining=CONTRACT_RETURN_MAX_BYTES-existingBytes;
    const makeFile=(size:number)=>({name:"第二份.pdf",type:"application/pdf",size});
    expect(formatContractReturnSize(remaining)).toBe("9.54 MiB");
    expect(contractReturnSelectionError([makeFile(remaining)],1,existingBytes)).toBeNull();
    const error=contractReturnSelectionError([makeFile(remaining+1)],1,existingBytes);
    expect(error).toContain("本次未上传");
    expect(error).toContain("第二份.pdf");
    expect(error).toContain("9.54 MiB");
    expect(error).toContain("超出额度 1 字节");
    expect(error).toContain("原有 1 份文件不受影响");
    expect(contractReturnSelectionError([makeFile(1)],3,100)).toContain("最多保存 3 份");
    expect(contractReturnSelectionError([{name:"说明.txt",type:"text/plain",size:1}],1,100)).toContain("格式不支持");
    expect(contractReturnSelectionError([makeFile(remaining),makeFile(1)],1,existingBytes)).toContain("合计");
  });
  it("confirms every bound attachment before showing success", () => {
    const rows=[{attachmentId:ids[0],filename:"第一份.pdf"},{attachmentId:ids[1],filename:"第二份.pdf"}];
    expect(confirmedContractReturnFiles(rows,[ids[1],ids[0]])).toEqual(["第二份.pdf","第一份.pdf"]);
    expect(confirmedContractReturnFiles(rows,[ids[0],ids[2]])).toBeNull();
  });
  it("reconciles a committed save after a lost POST response without resubmitting", async () => {
    const saved={attachments:[{attachmentId:ids[0],filename:"第二份.pdf"}]};
    const submit=vi.fn().mockRejectedValue(new Error("network timeout"));
    const read=vi.fn().mockResolvedValue(saved);
    await expect(confirmContractReturnSubmission([ids[0]],submit,read)).resolves.toBe(saved);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(1);
  });
  it("keeps the original save error if readback cannot confirm the attachment", async () => {
    const submit=vi.fn().mockRejectedValue(new Error("network timeout"));
    const read=vi.fn().mockResolvedValue({attachments:[]});
    await expect(confirmContractReturnSubmission([ids[0]],submit,read)).rejects.toThrow("network timeout");
    expect(submit).toHaveBeenCalledTimes(1);
  });
  it("cannot use a matching attachment from the wrong contract version to announce success", () => {
    const old={attachmentId:ids[0]!,filename:"原版追加.pdf",mimeType:"application/pdf" as const,sizeBytes:100};
    const original={signedContractDocumentId:ids[2]!,signedContractVersion:1,signedContractNumber:"V1",revision:1,submittedAt:"2026-11-19T00:00:00.000Z",uploadedByName:"TEST",attachments:[old]};
    const current={signedContractDocumentId:ids[3]!,attachments:[{...old,attachmentId:ids[1]!,filename:"新版.pdf"}],history:[original]};
    expect(confirmedContractReturnVersionFiles(current,[ids[0]!],ids[2]!)).toEqual(["原版追加.pdf"]);
    expect(confirmedContractReturnVersionFiles(current,[ids[0]!],ids[3]!)).toBeNull();
    expect(confirmedContractReturnVersionFiles(current,[ids[0]!,ids[1]!],ids[2]!)).toBeNull();
  });
  it("keeps an incomplete write response uncertain even when its follow-up read rejects", async () => {
    const submit=vi.fn().mockResolvedValue({attachments:[]});
    const read=vi.fn().mockRejectedValue(new Error("read forbidden"));
    await expect(confirmContractReturnSubmission([ids[0]],submit,read)).rejects.toThrow("合同回签保存结果尚未确认");
    expect(submit).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(1);
  });
  it("releases the original retry only for the definitive contract version conflict", () => {
    const versionMessage="合同版本已变化，请重新打开当前合同并回传对应版本";
    expect(isContractReturnVersionConflict(new SubmissionRequestError(versionMessage,"INVALID_STATE_TRANSITION",409))).toBe(true);
    expect(isContractReturnVersionConflict(new SubmissionRequestError("该请求标识已用于另一份回签合同","INVALID_STATE_TRANSITION",409))).toBe(false);
    expect(isContractReturnVersionConflict(new SubmissionRequestError(versionMessage,"INVALID_STATE_TRANSITION",503))).toBe(false);
    expect(isContractReturnVersionConflict(new DOMException("确认读取超时","AbortError"))).toBe(false);
  });
  it("preserves the save uncertainty after the confirmation read is aborted", async () => {
    const original=new TypeError("TEST lost write response");
    const submit=vi.fn().mockRejectedValue(original),read=vi.fn().mockRejectedValue(new DOMException("TEST read timeout","AbortError"));
    await expect(confirmContractReturnSubmission([ids[0]!],submit,read)).rejects.toBe(original);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(1);
  });
});
