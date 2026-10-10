import type { UploadIntentResponse } from "@dx-rework/contracts";
import type { DevelopmentDocument } from "@dx-rework/contracts/digital-development";
import { sha256Hex } from "./attachment-upload.js";
import { digitalRequest } from "./digital-production-api.js";
import { uploadPatternMaterial } from "./pattern-material-upload.js";

export async function uploadDevelopmentMaterial(base: string, original: File, kind: DevelopmentDocument["files"][number]["kind"], maxBytes: number): Promise<string> {
  return uploadPatternMaterial(original, async file => {
    if ((kind === "款图" || kind === "局部图") && file.type === "application/pdf") throw new Error("款图和局部图请使用 JPG、PNG 或 WebP；PDF 请放在菲林或工艺开发板附件中");
    const intent = await digitalRequest<UploadIntentResponse>(`${base}/upload-intents`, "POST", {filename: file.name, mimeType: file.type, sizeBytes: file.size, sha256: await sha256Hex(file)});
    const form = new FormData();
    for (const [name, value] of Object.entries(intent.uploadFields)) form.append(name, value);
    form.append("file", file);
    const response = await fetch(intent.uploadUrl, {method: intent.uploadMethod, body: form, credentials: "omit"});
    if (!response.ok) throw new Error(`${file.name}上传失败，请重试；其它资料仍保留`);
    await digitalRequest(`${base}/attachments/${intent.attachmentId}/finalize`, "POST", {});
    return intent.attachmentId;
  }, maxBytes);
}
