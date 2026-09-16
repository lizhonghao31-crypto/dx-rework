import { useEffect, useRef, useState } from "react";
import { Button } from "@dx-rework/ui";
import { ImageViewer } from "./image-viewer.js";
import { patternUrls } from "./pattern-order-client.js";

export type PatternMaterial = { attachmentId: string; filename: string; mimeType: string; active?: boolean };
const materialUrl = (id: string, mode: "thumbnail" | "preview" | "download") => patternUrls.apiUrl(`pattern-room/attachments/${id}/download?mode=${mode}`);

function MaterialThumbnail({ file }: { file: PatternMaterial }) {
  const [failed, setFailed] = useState(false);
  return failed ? <span>点击预览图片</span> : <img src={materialUrl(file.attachmentId, "thumbnail")} alt={file.filename} loading="lazy" onError={() => setFailed(true)} />;
}

function MaterialPreview({ files, selected, onSelect, onClose }: { files: PatternMaterial[]; selected: number; onSelect(index: number): void; onClose(): void }) {
  const dialog = useRef<HTMLDialogElement>(null), file = files[selected]!;
  useEffect(() => { const element = dialog.current; element?.showModal(); return () => element?.close(); }, []);
  const source = materialUrl(file.attachmentId, "preview");
  return <dialog ref={dialog} className="pattern-material-dialog rework-image-modal__content" aria-label="制作资料预览" onCancel={onClose}>
    <div className="rework-image-modal__heading"><strong>{file.filename}</strong><Button type="button" onClick={onClose}>关闭</Button></div>
    {file.mimeType.startsWith("image/") ? <ImageViewer key={file.attachmentId} src={source} alt={file.filename} /> : <iframe title={file.filename} src={source} className="pattern-pdf-preview" />}
    <div className="pattern-actions"><Button type="button" disabled={selected === 0} onClick={() => onSelect(selected - 1)}>上一份</Button><span>{selected + 1} / {files.length}</span><Button type="button" disabled={selected === files.length - 1} onClick={() => onSelect(selected + 1)}>下一份</Button><a href={source} target="_blank" rel="noreferrer">打开 / 打印</a><a href={materialUrl(file.attachmentId, "download")}>下载</a></div>
  </dialog>;
}

export function PatternMaterials({ files, onRemove, disabled = false, compact = false }: { files: PatternMaterial[]; onRemove?(id: string): void; disabled?: boolean; compact?: boolean }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = files.findIndex(file => file.attachmentId === selectedId);
  if (!files.length) return <p className="pattern-empty">暂无制作资料</p>;
  const visible = compact && !onRemove ? files.slice(0, 6) : files;
  return <><ul className="pattern-material-grid">{visible.map(file => <li key={file.attachmentId}>
    <button type="button" className="pattern-material-thumb" aria-label={`预览 ${file.filename}`} onClick={() => setSelectedId(file.attachmentId)}>{file.mimeType.startsWith("image/") ? <MaterialThumbnail file={file} /> : <span>PDF · 点击预览</span>}</button>
    <span className="pattern-material-name">{file.filename}{file.active === false ? "（历史资料）" : ""}</span>
    <div className="pattern-actions"><a href={materialUrl(file.attachmentId, "download")}>下载</a>{onRemove && <Button type="button" disabled={disabled} onClick={() => onRemove(file.attachmentId)}>移除</Button>}</div>
  </li>)}</ul>{visible.length < files.length && <Button type="button" onClick={() => setSelectedId(files[0]!.attachmentId)}>查看全部 {files.length} 份资料</Button>}{selected >= 0 && <MaterialPreview files={files} selected={selected} onSelect={index => setSelectedId(files[index]!.attachmentId)} onClose={() => setSelectedId(null)} />}</>;
}
