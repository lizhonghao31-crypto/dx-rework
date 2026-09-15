import { useState } from "react";
import type { ExternalResponsibilityCaseResponse } from "@dx-rework/contracts/external-responsibility";
import { createWebUrls } from "../url-contract.js";
import { ImageViewer } from "./image-viewer.js";

const { apiUrl } = createWebUrls(import.meta.env.BASE_URL);
const url = (id: string, mode: "preview" | "download") => apiUrl(`tools/attachments/${id}/download?mode=${mode}`);
type Evidence = NonNullable<ExternalResponsibilityCaseResponse["evidenceAttachments"]>[number];

export function ExternalEvidenceView({ attachmentIds, files }: {
  attachmentIds: readonly string[];
  files: readonly Evidence[];
}) {
  const [selected, setSelected] = useState<Evidence | null>(null);
  const [failed, setFailed] = useState<readonly string[]>([]);
  if (!attachmentIds.length) return null;
  return <div className="external-saved-evidence" aria-label="本笔记录凭证">
    {attachmentIds.map(id => {
      const file = files.find(item => item.attachmentId === id);
      if (!file) return <small key={id} role="status">凭证信息不可用，请核对原记录。</small>;
      return <div key={id}>
        {file.mimeType.startsWith("image/") ? <button type="button" className="rework-detail-image-card" onClick={() => setSelected(file)} aria-label={`放大查看 ${file.filename}`}>
          {failed.includes(id) ? <small role="status">凭证图片加载失败</small> : <img src={url(id,"preview")} alt={file.filename} loading="lazy" onError={() => setFailed(current => [...current,id])} />}
          <span>{file.filename}</span>
        </button> : <span>{file.filename} · <a href={url(id,"preview")} target="_blank" rel="noreferrer">预览</a></span>}
        {" · "}<a href={url(id,"download")} target="_blank" rel="noreferrer">下载</a>
      </div>;
    })}
    {selected && <div className="rework-image-modal" role="presentation" onMouseDown={() => setSelected(null)}>
      <section className="rework-image-modal__content" role="dialog" aria-modal="true" aria-label={`扣款凭证：${selected.filename}`} onMouseDown={event => event.stopPropagation()}>
        <div className="rework-image-modal__heading"><strong>{selected.filename}</strong><button type="button" onClick={() => setSelected(null)}>关闭</button></div>
        <ImageViewer src={url(selected.attachmentId,"preview")} alt={selected.filename} />
        <a href={url(selected.attachmentId,"download")} target="_blank" rel="noreferrer">下载原图</a>
      </section>
    </div>}
  </div>;
}
