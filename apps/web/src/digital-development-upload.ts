import type { DevelopmentDocument } from "@dx-rework/contracts/digital-development";
import {uploadAttachmentWithRecovery} from './attachment-upload-recovery.js';
import { digitalRequest } from "./digital-production-api.js";
import { uploadPatternMaterial } from "./pattern-material-upload.js";

export async function uploadDevelopmentMaterial(base: string, original: File, kind: DevelopmentDocument["files"][number]["kind"], maxBytes: number): Promise<string> {
  return uploadPatternMaterial(original, async file => {
    if ((kind === "款图" || kind === "局部图") && file.type === "application/pdf") throw new Error("款图和局部图请使用 JPG、PNG 或 WebP；PDF 请放在菲林或工艺开发板附件中");
    return (await uploadAttachmentWithRecovery(file,`development:${base}:${kind}`,{
      createIntent:input=>digitalRequest(`${base}/upload-intents`,'POST',input),
      finalize:id=>digitalRequest(`${base}/attachments/${id}/finalize`,'POST',{}),
    },undefined,undefined,original)).attachmentId;
  }, maxBytes);
}
