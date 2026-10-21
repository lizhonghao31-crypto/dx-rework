import type { AttachmentResponse, CreateUploadIntent, UploadIntentResponse } from "@dx-rework/contracts";
import { prepareImageUploadCandidate, uploadImageWithNormalizationRetry } from "./attachment-upload.js";
import {uploadAttachmentWithRecovery,localFileScope} from "./attachment-upload-recovery.js";
import { sampleErrorMessage } from "./sample-request.js";

export type SampleUploadApi = {
  recoveryScope?:string;
  createIntent(input: CreateUploadIntent): Promise<UploadIntentResponse>;
  finalize(attachmentId: string): Promise<AttachmentResponse>;
};

export async function uploadSampleImage(original: File, api: SampleUploadApi): Promise<AttachmentResponse> {
  let stage = "图片准备";
  try {
    const prepared = await prepareImageUploadCandidate(original);
    return await uploadImageWithNormalizationRetry(original, prepared, async file => {
      stage = "图片上传与校验";
      const result = await uploadAttachmentWithRecovery(file,api.recoveryScope??`sample:${localFileScope(original)}`,api,undefined,undefined,original);
      return result;
    });
  } catch (error) {
    throw new Error(`${stage}失败：${sampleErrorMessage(error, "请检查网络后重试")}`);
  }
}
