import type { ReactNode } from 'react';
import { formatBusinessDecimal } from '@dx-rework/contracts/business-display';
import './sourcing-order-photos.css';

type Photo = { attachmentId: string; filename: string };

/** Order-local reading surface. Callers keep their existing authorization and preview callbacks. */
export function SourcingOrderPhotos<T extends Photo>({ attachments, previewUrl, onPreview, uploadControl }: {
  attachments: readonly T[];
  previewUrl: (photo: T) => string;
  onPreview: (photo: T) => void;
  uploadControl?: ReactNode;
}) {
  const first = attachments[0];
  return <section className="sourcing-order-photos" aria-label="订单图片">
    <div className="sourcing-order-photos__heading"><h2>订单图片</h2>{uploadControl}<span>{formatBusinessDecimal(attachments.length)} 张</span></div>
    <div className="sourcing-order-photos__body">
    {first ? <button type="button" className="sourcing-order-photos__preview" aria-label={`放大查看 ${first.filename}`} onClick={() => onPreview(first)}>
      <img src={previewUrl(first)} alt={first.filename} loading="lazy" />
    </button> : <p className="sourcing-order-photos__empty">本单没有图片</p>}
    <div className="sourcing-order-photos__files" tabIndex={0} role="region" aria-label="订单图片文件列表">{attachments.map(photo => <details key={photo.attachmentId} className="sourcing-order-photo-file">
      <summary title={photo.filename} aria-label={`展开完整文件名：${photo.filename}`}>
        <span className="sourcing-order-photo-file__type">{photo.filename.split('.').at(-1)?.toUpperCase() || '图片'}</span>
        <span className="sourcing-order-photo-file__short">{photo.filename}</span>
        <span className="sourcing-order-photo-file__toggle">全名</span>
        <span className="sourcing-order-photo-file__peek" aria-hidden="true">{photo.filename}</span>
      </summary>
      <div className="sourcing-order-photo-file__full"><p>{photo.filename}</p><button type="button" className="dx-button dx-button--secondary" onClick={() => onPreview(photo)}>查看原附件</button></div>
    </details>)}</div>
    </div>
  </section>;
}
