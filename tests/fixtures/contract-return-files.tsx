import "../../packages/ui/src/tokens.css";
import "../../packages/ui/src/components.css";
import { createRoot } from "react-dom/client";
import { SourcingContractReturnResponseSchema } from "@dx-rework/contracts";
import { SourcingContractReturnFiles } from "../../apps/web/src/sourcing-contract-return-files.js";
import "../../apps/web/src/sourcing-workspace.css";
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const file=(n:number)=>({attachmentId:id(n),filename:n===2?"TEST-很长的回签附件名称".repeat(8)+".png":`TEST-${n}.pdf`,mimeType:n===2?"image/png":"application/pdf",sizeBytes:128});
const value=SourcingContractReturnResponseSchema.parse({contractReturnMonitoring:true,contractReturnStatus:"returned_on_time",contractGeneratedAt:null,contractReturnDueAt:null,contractReturnedAt:"2026-11-01T10:00:00Z",contractReturnOverdueHours:0,uploadedByName:"TEST跟单",canUpload:false,currentContractDocumentId:id(20),currentContractReturned:true,signedContractDocumentId:id(20),signedContractVersion:2,attachments:[file(1),file(2),file(3)],history:[
  {revision:1,submittedAt:"2026-11-01T10:00:00Z",uploadedByName:"TEST跟单",signedContractDocumentId:id(20),signedContractVersion:2,attachments:[file(1)]},
  {revision:2,submittedAt:"2026-10-01T10:00:00Z",uploadedByName:"TEST旧跟单",signedContractDocumentId:id(10),signedContractVersion:1,attachments:[file(4)]},
  {revision:3,submittedAt:"2026-09-01T10:00:00Z",uploadedByName:"TEST历史跟单",signedContractDocumentId:null,signedContractVersion:null,attachments:[file(5)]},
]});
const scenario=new URLSearchParams(location.search).get("scenario");
if(scenario==="empty"){value.attachments=[];value.history=[];}
if(scenario==="new-version"){value.currentContractDocumentId=id(30);value.currentContractReturned=false;}
createRoot(document.getElementById("root")!).render(<SourcingContractReturnFiles value={value} attachmentUrl={(attachmentId,mode)=>`/files/${attachmentId}?mode=${mode}`} />);
