import { describe, expect, it } from "vitest";
import { SourcingContractReturnResponseSchema } from "../../packages/contracts/src/sourcing.js";
import { contractReturnFileGroups } from "../../apps/web/src/sourcing-contract-return-files.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const file = (n: number) => ({attachmentId:id(n),filename:`回签${n}.pdf`,mimeType:"application/pdf",sizeBytes:128});
const value = (extra: Record<string, unknown> = {}) => SourcingContractReturnResponseSchema.parse({
  contractReturnMonitoring:true,contractReturnStatus:"returned_on_time",contractGeneratedAt:null,contractReturnDueAt:null,
  contractReturnedAt:"2026-11-01T10:00:00Z",contractReturnOverdueHours:0,uploadedByName:"跟单",canUpload:false,
  currentContractDocumentId:id(20),signedContractDocumentId:id(20),signedContractVersion:2,attachments:[file(1),file(2),file(3)],
  history:[{revision:1,submittedAt:"2026-11-01T10:00:00Z",uploadedByName:"跟单",signedContractDocumentId:id(20),signedContractVersion:2,attachments:[file(1)]}],...extra,
});

describe("unified contract return file groups", () => {
  it("shows each of three files once despite aggregated submission history", () => {
    expect(contractReturnFileGroups(value()).map(group=>group.files.map(item=>item.attachmentId))).toEqual([[id(1),id(2),id(3)]]);
  });
  it("keeps current, historical and unrecorded versions separate without truncating legacy files", () => {
    const input=value();
    input.history.push({revision:2,submittedAt:"2026-11-01T10:00:00Z",uploadedByName:"跟单",signedContractDocumentId:id(10),signedContractVersion:1,signedContractNumber:null,attachments:[4,5,6,7].map(n=>({...file(n),mimeType:"application/pdf" as const}))});
    input.history.push({revision:3,submittedAt:"2026-11-01T10:00:00Z",uploadedByName:"跟单",signedContractDocumentId:null,signedContractVersion:null,signedContractNumber:null,attachments:[{...file(8),mimeType:"application/pdf"}]});
    const groups=contractReturnFileGroups(input);
    expect(groups.map(group=>group.documentId)).toEqual([id(20),id(10),null]);
    expect(groups.map(group=>group.files.length)).toEqual([3,4,1]);
    expect(contractReturnFileGroups({...input,currentContractDocumentId:id(30)}).map(group=>group.documentId)).toEqual([id(20),id(10),null]);
  });
  it("has no files to expose when the API denies contract file reading", () => {
    expect(contractReturnFileGroups(value({attachments:[],history:[]}))).toEqual([]);
  });
});
