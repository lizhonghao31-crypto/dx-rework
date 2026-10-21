import {uploadAttachmentWithRecovery,attachmentJson} from "./attachment-upload-recovery.js";
import { formatBusinessDecimal } from "@dx-rework/contracts/business-display";
import {
  AttachmentResponseSchema,
  UploadIntentResponseSchema,
} from "@dx-rework/contracts";
import { Button, StatusBadge } from "@dx-rework/ui";
import { useState,useRef,useEffect,useId } from "react";

import {
  isSupportedAttachment,
  prepareAttachmentForUpload,
} from "./attachment-upload.js";


const prepareTimeoutMilliseconds = 30_000;
const apiTimeoutMilliseconds = 15_000;

type UploadStage = "preparing" | "uploading" | "verifying";

const stageLabel: Record<UploadStage, string> = {
  preparing: "正在准备文件",
  uploading: "正在上传文件",
  verifying: "正在确认文件已入库",
};

type UploadedEvidence = {
  attachmentId: string;
  filename: string;
};

const request = async <T,>(path:string,schema:{parse(value:unknown):T},init:RequestInit):Promise<T>=>withTimeout(signal=>attachmentJson(path,value=>schema.parse(value),{...init,signal}),apiTimeoutMilliseconds,'服务器响应超时');

const withTimeout = async <T,>(
  operation: (signal: AbortSignal) => Promise<T>,
  milliseconds: number,
  message: string,
): Promise<T> => {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(controller.signal),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error(message));
        }, milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

export function ExternalEvidenceUploader({
  attachmentIds,
  scope,
  disabled,
  onChange,
  onMessage,
  onUploadingChange,
}: {
  attachmentIds: readonly string[];
  scope?:string;
  disabled: boolean;
  onChange(value: string[]): void;
  onMessage(message: string): void;
  onUploadingChange?(uploading: boolean): void;
}) {
  const instance=useId(),inFlight=useRef(false),generation=useRef(0),pendingFiles=useRef<File[]>([]);
  const [pendingCount,setPendingCount]=useState(0);
  useEffect(()=>{generation.current++;inFlight.current=false;pendingFiles.current=[];setPendingCount(0);setUploaded([]);setUploading(false);return()=>{generation.current++;if(inFlight.current){inFlight.current=false;onUploadingChange?.(false);}};},[scope]);
  const [uploaded, setUploaded] = useState<UploadedEvidence[]>([]);
  const [uploading, setUploading] = useState(false);
  const [stage, setStage] = useState<UploadStage | null>(null);
  const [failedFile, setFailedFile] = useState<string | null>(null);

  const uploadFiles = async (files: FileList | File[] | null): Promise<void> => {
    if (!files?.length || disabled || inFlight.current || uploading) return;
    inFlight.current=true;const context=generation.current;pendingFiles.current=Array.from(files);setPendingCount(pendingFiles.current.length);
    setUploading(true);
    onUploadingChange?.(true);
    setFailedFile(null);
    let activeFileName = "所选文件";
    try {
      const nextIds = [...attachmentIds];
      const nextUploaded = [...uploaded];
      for (const file of Array.from(files)) {
        activeFileName = file.name;
        setStage("preparing");
        if (!isSupportedAttachment(file)) {
          throw new Error(`${file.name} 不是支持的图片或 PDF`);
        }
        const prepared = await withTimeout(
          async () => prepareAttachmentForUpload(file),
          prepareTimeoutMilliseconds,
          `${file.name} 文件准备超时`,
        );
        const finalized=await uploadAttachmentWithRecovery(prepared,`external-evidence:${scope??instance}`,{
          createIntent:input=>request('tools/attachments/upload-intents',UploadIntentResponseSchema,{method:'POST',body:JSON.stringify(input)}),
          finalize:id=>request(`tools/attachments/${id}/finalize`,AttachmentResponseSchema,{method:'POST'}),
        },undefined,(phase,operation)=>{setStage(phase==='finalize'?'verifying':'uploading');return operation();},file);
        if(context!==generation.current)return;
        nextIds.push(finalized.attachmentId);
        nextUploaded.push({
          attachmentId: finalized.attachmentId,
          filename: finalized.filename,
        });
        pendingFiles.current=pendingFiles.current.slice(1);setPendingCount(pendingFiles.current.length);
        onChange([...new Set(nextIds)]);setUploaded([...nextUploaded]);
      }
      onChange([...new Set(nextIds)]);
      setUploaded(nextUploaded);
      onMessage(`${formatBusinessDecimal(nextIds.length)} 份证据附件已就绪，提交动作后将锁定到该台账。`);
    } catch (error: unknown) {
      if(context!==generation.current)return;setFailedFile(activeFileName);
      onMessage(`${error instanceof Error ? error.message : "附件上传失败"}。已完成文件保留；请重试未完成附件，文件就绪后仍需提交台账。`);
    } finally {
      if(context===generation.current){inFlight.current=false;setUploading(false);
      onUploadingChange?.(false);
      setStage(null);}
    }
  };

  const remove = (attachmentId: string): void => {
    onChange(attachmentIds.filter((item) => item !== attachmentId));
    setUploaded((current) =>
      current.filter((item) => item.attachmentId !== attachmentId));
  };

  return (
    <div className="external-evidence-uploader">
      <label className="dx-field">
        <span>证据附件</span>
        <span className="dx-field__control">
          <input
            type="file"
            multiple
            accept="image/jpeg,image/png,image/webp,application/pdf"
            disabled={disabled || uploading || pendingCount>0}
            onChange={(event) => {
              void uploadFiles(event.target.files);
              event.target.value = "";
            }}
          />
        </span>
      </label>
      <small>支持 JPG、PNG、WebP 和 PDF；文件就绪后仍须提交原台账动作才保存引用；无需填写附件 ID。</small>
      {uploading && stage && <StatusBadge tone="warning">{stageLabel[stage]}</StatusBadge>}
      {!uploading && failedFile && (
        <small className="external-upload-error" role="alert">
          {failedFile} 尚未取得就绪回执，已成功部分保留。
        </small>
      )}
      {!uploading&&pendingCount>0&&<><Button disabled={disabled} onClick={()=>void uploadFiles(pendingFiles.current)}>重试未完成附件</Button><Button disabled={disabled} onClick={()=>{pendingFiles.current=[];setPendingCount(0);setFailedFile(null);onMessage('已停止本页剩余附件选择；此前请求不会撤销，已上传文件仍按原记录核对。');}}>停止剩余上传</Button></>}
      {uploaded.length > 0 && (
        <div className="external-evidence-list">
          {uploaded.map((item) => (
            <div key={item.attachmentId}>
              <span>{item.filename}</span>
              <Button
                disabled={disabled || uploading}
                onClick={() => remove(item.attachmentId)}
              >
                移除
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
