import {useDigitalDetailNavigationGuard} from "./use-digital-detail-navigation-guard.js";
import {RequestFeedbackError} from "./request-response-feedback.js";
import {SubmissionRequestError} from "./submission-validation.js";
import {SubmissionAttempt} from "./submission-attempt.js";
import {uploadAttachmentWithRecovery,toolsAttachmentApi,attachmentJson} from "./attachment-upload-recovery.js";
import { formatBusinessDecimal } from "@dx-rework/contracts/business-display";
import {
  MAX_REWORK_ATTACHMENTS,
  ReworkOrderResponseSchema,
} from "@dx-rework/contracts";
import { useState,useRef,useEffect } from "react";

import { createClientRequestId } from "./client-request-id.js";
import {
  currentQcUploadConcurrency,
  currentUploadClientProfile,
  isImageUploadCandidate,
  measureAttachmentUploadStage,
  prepareAndUploadWithConcurrency,
  prepareImageUploadCandidate,
  sha256Hex,
  uploadImageWithNormalizationRetry,
  type AttachmentUploadTimingContext,
} from "./attachment-upload.js";

type ApiSchema<T>={parse(value:unknown):T};
const request=<T,>(path:string,schema:ApiSchema<T>,init:RequestInit={})=>attachmentJson(path,value=>schema.parse(value),init).catch(error=>{if(error instanceof RequestFeedbackError&&error.outcome==='rejected')throw new SubmissionRequestError(error.message,error.code,error.status??400);throw error;});

export function OrderImageSupplementUploader({
  reworkOrderId,
  expectedVersion,
  currentAttachmentCount,
  onUploaded,
}: {
  reworkOrderId: string;
  expectedVersion: number;
  currentAttachmentCount: number;
  onUploaded(): Promise<{reworkOrderId:string;version:number}>;
}) {
  const inFlight=useRef(false),context=useRef(0),pendingFiles=useRef<File[]>([]),binding=useRef<{key:string;body:unknown}|null>(null),acknowledged=useRef(false),definitive=useRef(false),attempt=useRef(new SubmissionAttempt());
  useEffect(()=>{context.current++;inFlight.current=false;pendingFiles.current=[];binding.current=null;acknowledged.current=false;definitive.current=false;attempt.current=new SubmissionAttempt();setUploading(false);setMessage('');setRefreshedVersion(null);return()=>{context.current++;};},[reworkOrderId]);
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState("");
  const [refreshedVersion,setRefreshedVersion]=useState<number|null>(null);
  useDigitalDetailNavigationGuard(pendingFiles.current.length>0&&!acknowledged.current,uploading,inFlight,'本页附件或原绑定结果尚未确认；离开会丢失本地文件与恢复记录，原请求不会撤销。仍要离开？');
  const remaining = Math.max(0, MAX_REWORK_ATTACHMENTS - currentAttachmentCount);

  const uploadImages = async (files: FileList | File[] | null): Promise<void> => {
    if (!files?.length || inFlight.current || uploading || remaining === 0&&!binding.current) return;
    const revision=context.current;const show=(value:string)=>{if(revision===context.current)setMessage(value);};
    const finishBinding=async()=>{const command=binding.current;if(!command)return;
      if(acknowledged.current){await onUploaded();if(revision===context.current){pendingFiles.current=[];binding.current=null;show('图片已保存，已重新读取原订单');}return;}
      const currentAttempt=attempt.current;
      const execute=async()=>{
        const value=await request(`rework-orders/${reworkOrderId}/supplemental-images`,ReworkOrderResponseSchema,{method:'POST',headers:{'idempotency-key':command.key},body:JSON.stringify(command.body)});
        const input=command.body as {expectedVersion:number;attachmentIds:string[]};if(value.reworkOrderId!==reworkOrderId||value.version!==input.expectedVersion+1||!input.attachmentIds.every(id=>value.attachmentIds.includes(id)))throw new Error('未取得本单全部原图片的绑定回执');
        currentAttempt.markConfirmed();if(revision!==context.current)return;acknowledged.current=true;
        await onUploaded();if(revision===context.current){pendingFiles.current=[];binding.current=null;show('图片已补充并重新读取原订单');}
      };
      const result=currentAttempt.hasPending?await currentAttempt.retry():await currentAttempt.run(execute);
      if(revision!==context.current)return;
      if(result.kind==='failure'){definitive.current=!result.uncertain&&!acknowledged.current;setRefreshedVersion(null);show(`${acknowledged.current?'图片引用已保存；重新读取原订单失败':result.uncertain?'文件已就绪，原绑定结果尚未确认':'文件已就绪，本单图片引用未保存'}：${result.failure.message}`);}
      if(result.kind==='expired')show('原图片绑定已超过安全恢复期限；请核对原订单图片，不再重发。文件标识保留。');
    };
    if(binding.current){inFlight.current=true;setUploading(true);try{await finishBinding();}catch(error){show(`图片引用已保存，重读原订单失败：${error instanceof Error?error.message:'读取未完成'}`);}finally{if(revision===context.current){inFlight.current=false;setUploading(false);}}return;}
    const selected = Array.from(files);
    const unsupported = selected.find((file) => !isImageUploadCandidate(file));
    if (unsupported) {
      show(`${unsupported.name} 不是支持的图片格式`);
      return;
    }
    if (selected.length > remaining) {
      show(`还可补充 ${formatBusinessDecimal(remaining)} 张；请减少本次选择数量后重试`);
      return;
    }

    pendingFiles.current=selected;inFlight.current=true;setUploading(true);
    show(`正在处理 ${formatBusinessDecimal(selected.length)} 张订单图片…`);
    let completedUploadCount = 0;
    try {
      const profile = currentUploadClientProfile();
      const attachmentIds = await prepareAndUploadWithConcurrency(
        selected,
        currentQcUploadConcurrency(),
        async (file, index) => {
          show(`正在处理第 ${index + 1}/${selected.length} 张订单图片…`);
          const baseTiming: AttachmentUploadTimingContext = {
            diagnosticId: createClientRequestId(),
            ...profile,
            originalBytes: file.size,
            uploadBytes: file.size,
            mimeType: file.type,
          };
          const prepared = await measureAttachmentUploadStage(
            baseTiming,
            "prepare",
            () => prepareImageUploadCandidate(file),
          );
          const timing = { ...baseTiming, uploadBytes: prepared.size, mimeType: prepared.type };
          const sha256 = await measureAttachmentUploadStage(timing, "hash", () => sha256Hex(prepared));
          return { file: prepared, timing, sha256 };
        },
        async ({ file, timing, sha256 }, sourceFile, index): Promise<string> => {
          show(`正在上传第 ${index + 1}/${selected.length} 张订单图片…`);
          return uploadImageWithNormalizationRetry(sourceFile, file, async (candidate) => {
            const candidateTiming = candidate === file
              ? timing
              : { ...timing, uploadBytes: candidate.size, mimeType: candidate.type };
            const candidateSha256 = candidate === file
              ? sha256
              : await measureAttachmentUploadStage(
                  candidateTiming,
                  "hash",
                  () => sha256Hex(candidate),
                );
            const finalized=await uploadAttachmentWithRecovery(candidate,`rework-images:${reworkOrderId}:${expectedVersion}`,toolsAttachmentApi,candidateSha256,
              (stage,operation)=>measureAttachmentUploadStage(candidateTiming,stage,operation),sourceFile);
            completedUploadCount += 1;
            show(`已上传 ${formatBusinessDecimal(completedUploadCount)}/${formatBusinessDecimal(selected.length)} 张订单图片…`);
            return finalized.attachmentId;
          });
        },
      );
      if(revision!==context.current)return;binding.current={key:createClientRequestId(),body:{ expectedVersion, attachmentIds }};await finishBinding();
    } catch (error: unknown) {
      show(error instanceof Error ? error.message : "订单图片上传失败");
    } finally {
      if(revision===context.current){inFlight.current=false;setUploading(false);}
    }
  };

  return (
    <div className="rework-detail-image-upload">
      {message && <p role="status">{message}</p>}
      {!uploading&&pendingFiles.current.length>0&&<button type="button" onClick={()=>void uploadImages(pendingFiles.current)}>{acknowledged.current?'只重新读取原订单':binding.current?'使用原内容核对图片绑定':'重试未完成图片'}</button>}
      {!uploading&&binding.current&&<button type="button" onClick={()=>{if(inFlight.current)return;const revision=context.current;inFlight.current=true;setUploading(true);setRefreshedVersion(null);void onUploaded().then(value=>{if(revision!==context.current)return;if(value.reworkOrderId!==reworkOrderId||!Number.isSafeInteger(value.version)||value.version<1)throw Error('原订单尚未取得匹配的当前版本');if(definitive.current)setRefreshedVersion(value.version);setMessage('已重新读取原订单；原图片绑定回执仍按原提交核对，未因读取自动重发。');}).catch(error=>{if(revision===context.current)setMessage(`原订单尚未读取：${error instanceof Error?error.message:'读取未完成'}`);}).finally(()=>{if(revision===context.current){inFlight.current=false;setUploading(false);}});}}>仅核对原订单图片</button>}
      {!uploading&&binding.current&&definitive.current&&<button type="button" disabled={refreshedVersion===null||refreshedVersion!==expectedVersion} onClick={()=>{if(refreshedVersion===null||refreshedVersion!==expectedVersion)return;const old=binding.current!;binding.current={key:createClientRequestId(),body:{...(old.body as {attachmentIds:string[]}),expectedVersion:refreshedVersion}};attempt.current=new SubmissionAttempt();definitive.current=false;setRefreshedVersion(null);void uploadImages(pendingFiles.current);}}>按当前版本重新提交已就绪图片</button>}
      <label className="qc-file-button rework-detail-image-upload__button">
        <span>{uploading ? "正在上传…" : remaining > 0 ? "上传图片" : `已达 ${MAX_REWORK_ATTACHMENTS} 张上限`}</span>
        <input
          type="file"
          accept="image/*"
          multiple
          disabled={uploading || remaining === 0 || pendingFiles.current.length>0}
          onChange={(event) => {
            void uploadImages(event.target.files);
            event.target.value = "";
          }}
        />
      </label>
    </div>
  );
}
