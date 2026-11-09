import { Button } from "@dx-rework/ui";
import "./system-dialog.css";
import "./dialog-visual-system.css";
import type { SourcingContractReturnResponse } from "@dx-rework/contracts";
import { useEffect, useRef, useState } from "react";
import { ImageViewer } from "./image-viewer.js";

type ReturnFile = SourcingContractReturnResponse["attachments"][number];
export type ReturnFileGroup = {
  documentId: string | null;
  version: number | null;
  files: ReturnFile[];
};

// The current array aggregates submissions; history includes some of those same files.
export function contractReturnFileGroups(value: SourcingContractReturnResponse): ReturnFileGroup[] {
  const groups = new Map<string | null, ReturnFileGroup>();
  const add = (documentId: string | null, version: number | null, files: ReturnFile[]) => {
    if (!files.length) return;
    const group = groups.get(documentId) ?? { documentId, version, files: [] };
    for (const file of files) if (!group.files.some(item => item.attachmentId === file.attachmentId)) group.files.push(file);
    groups.set(documentId, group);
  };
  add(value.signedContractDocumentId, value.signedContractVersion, value.attachments);
  for (const submission of [...value.history].reverse()) add(submission.signedContractDocumentId, submission.signedContractVersion, submission.attachments);
  return [...groups.values()].sort((a, b) => {
    const current = value.currentContractDocumentId;
    if (current !== null && a.documentId === current) return -1;
    if (current !== null && b.documentId === current) return 1;
    return (b.version ?? 0) - (a.version ?? 0);
  });
}

const groupLabel = (group: ReturnFileGroup, current: string | null) =>
  group.version === null ? "版本未记录" : `合同 V${group.version}${group.documentId === current ? "（当前版本）" : "（历史版本）"}`;

type Props = {
  value: SourcingContractReturnResponse;
  attachmentUrl(id: string, mode: "preview" | "download"): string;
};

function ReturnFilesDialog({ value, groups, attachmentUrl, onClose }: Props & { groups: ReturnFileGroup[]; onClose(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [selectedId, setSelectedId] = useState(groups[0]!.files[0]!.attachmentId);
  const [failed, setFailed] = useState(false);
  const files = groups.flatMap(group => group.files);
  const index = Math.max(0, files.findIndex(file => file.attachmentId === selectedId));
  const selected = files[index]!;
  const group = groups.find(item => item.files.some(file => file.attachmentId === selected.attachmentId))!;
  useEffect(() => { const element = dialog.current; element?.showModal(); return () => element?.close(); }, []);
  useEffect(() => { setFailed(false); }, [selected.attachmentId]);
  const close = () => { dialog.current?.close(); onClose(); };
  return <dialog ref={dialog} className="system-dialog sourcing-return-files-dialog" aria-label="查看回签文件" onCancel={event => { event.preventDefault(); close(); }}>
    <div className="sourcing-return-files-heading"><h2>回签文件</h2><Button type="button" onClick={close}>关闭</Button></div>
    {!value.currentContractReturned && value.currentContractDocumentId ? <p role="status">本版本无回签记录，以下为历史回签文件。</p> : null}
    <nav aria-label="全部回签文件">{groups.map(item => <section key={item.documentId ?? "unrecorded"}>
      <h3>{groupLabel(item, value.currentContractDocumentId)}</h3>
      <div className="sourcing-return-files-list">{item.files.map(file => <Button type="button" key={file.attachmentId}
        variant={file.attachmentId === selected.attachmentId ? "primary" : "secondary"} aria-pressed={file.attachmentId === selected.attachmentId} onClick={() => setSelectedId(file.attachmentId)}>{file.filename}</Button>)}</div>
    </section>)}</nav>
    <p>{groupLabel(group, value.currentContractDocumentId)} · {selected.filename}</p>
    <div className="sourcing-return-files-preview" onErrorCapture={() => setFailed(true)}>
      {failed ? <p role="alert">文件预览失败，请重试或打开原文件。</p> : selected.mimeType === "application/pdf"
        ? <iframe key={selected.attachmentId} title={selected.filename} src={attachmentUrl(selected.attachmentId, "preview")} onError={() => setFailed(true)} />
        : <ImageViewer key={selected.attachmentId} src={attachmentUrl(selected.attachmentId, "preview")} alt={selected.filename} />}
    </div>
    <div className="system-dialog__actions sourcing-return-files-controls">
      <Button type="button" disabled={index === 0} onClick={() => setSelectedId(files[index - 1]!.attachmentId)}>上一份</Button>
      <span>{index + 1} / {files.length}</span>
      <Button type="button" disabled={index === files.length - 1} onClick={() => setSelectedId(files[index + 1]!.attachmentId)}>下一份</Button>
      {failed ? <Button type="button" onClick={() => setFailed(false)}>重试预览</Button> : null}
      <a className="dx-button dx-button--secondary" href={attachmentUrl(selected.attachmentId, "preview")} target="_blank" rel="noreferrer">打开原文件</a>
      <a className="dx-button dx-button--secondary" href={attachmentUrl(selected.attachmentId, "download")} target="_blank" rel="noreferrer">下载</a>
    </div>
    <p>PDF 无法在当前浏览器内显示时，可打开原文件查看。</p>
    {value.history.length ? <details><summary>历史上传记录</summary>{value.history.map(submission => <p key={submission.revision}>
      第 {submission.revision} 次 · {submission.signedContractVersion ? `合同 V${submission.signedContractVersion}${submission.signedContractNumber ? ` · ${submission.signedContractNumber}` : ""}` : "版本未记录"} · {submission.uploadedByName} · {new Date(submission.submittedAt).toLocaleString("zh-CN")} · {submission.attachments.map(file => file.filename).join("、")}
    </p>)}</details> : null}
  </dialog>;
}

export function SourcingContractReturnFiles(props: Props) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const groups = contractReturnFileGroups(props.value);
  if (!groups.length) return null;
  return <><button ref={trigger} className="dx-button dx-button--secondary" type="button" onClick={() => setOpen(true)}>查看回签文件</button>
    {open ? <ReturnFilesDialog {...props} groups={groups} onClose={() => { setOpen(false); trigger.current?.focus(); }} /> : null}</>;
}
