import type { AttachmentResponse, CreateUploadIntent, UploadIntentResponse } from "@dx-rework/contracts";
import { prepareImageUploadCandidate, sha256Hex, uploadImageWithNormalizationRetry } from "./attachment-upload.js";
import { sampleErrorMessage } from "./sample-request.js";

export type SampleUploadApi = {
  createIntent(input: CreateUploadIntent): Promise<UploadIntentResponse>;
  finalize(attachmentId: string): Promise<AttachmentResponse>;
};

export async function uploadSampleImage(original: File, api: SampleUploadApi): Promise<AttachmentResponse> {
  let stage = "图片准备";
  try {
    const prepared = await prepareImageUploadCandidate(original);
    return await uploadImageWithNormalizationRetry(original, prepared, async file => {
      stage = "图片校验";
      const sha256 = await sha256Hex(file);
      stage = "上传申请";
      const intent = await api.createIntent({ filename: file.name, mimeType: file.type as CreateUploadIntent["mimeType"], sizeBytes: file.size, sha256 });
      const form = new FormData();
      for (const [key, value] of Object.entries(intent.uploadFields)) form.append(key, value);
      form.append("file", file);
      stage = "图片上传";
      const response = await fetch(intent.uploadUrl, { method: intent.uploadMethod, body: form, credentials: "omit" });
      if (!response.ok) throw new Error("图片传输失败，请检查网络后重试");
      stage = "上传确认";
      const result = await api.finalize(intent.attachmentId);
      if (result.status !== "ready") throw new Error("图片尚未确认完成，请重试");
      return result;
    });
  } catch (error) {
    throw new Error(`${stage}失败：${sampleErrorMessage(error, "请检查网络后重试")}`);
  }
}
