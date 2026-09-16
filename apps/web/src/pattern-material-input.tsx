import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@dx-rework/ui";
import { readPatternUploadLimits } from "./pattern-order-client.js";

export const PATTERN_MATERIAL_LIMIT = 20;

export function PatternMaterialInput({ kind, purpose = "create", count, label, disabled, onFiles }: {
  kind: "pattern" | "misc"; purpose?: "create" | "rework"; count: number; label: string;
  disabled: boolean; onFiles(files: File[]): void;
}) {
  const input = useRef<HTMLInputElement>(null), hintId = useId();
  const [limits, setLimits] = useState<number | null>(null), [failed, setFailed] = useState(false), [retry, setRetry] = useState(0);
  useEffect(() => {
    const abort = new AbortController(); setLimits(null); setFailed(false);
    void readPatternUploadLimits(kind, purpose, abort.signal).then(value => {
      if (!abort.signal.aborted) setLimits(value.maxUploadBytes);
    }).catch(() => { if (!abort.signal.aborted) setFailed(true); });
    return () => abort.abort();
  }, [kind, purpose, retry]);
  return <div className="pattern-material-input">
    <div className="pattern-material-input__actions">
      <Button type="button" variant="primary" disabled={disabled || count >= PATTERN_MATERIAL_LIMIT} aria-describedby={hintId} onClick={() => input.current?.click()}>{label}</Button>
      <span aria-live="polite">资料 {count}/{PATTERN_MATERIAL_LIMIT}</span>
    </div>
    <input ref={input} type="file" hidden multiple accept="application/pdf,image/*,.pdf,.jpg,.jpeg,.png,.webp" aria-label={label} disabled={disabled || count >= PATTERN_MATERIAL_LIMIT} onChange={event => {
      const selected = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = "";
      if (selected.length) onFiles(selected);
    }} />
    <p id={hintId} className="pattern-material-input__hint">图片与 PDF 合计最多 {PATTERN_MATERIAL_LIMIT} 份{purpose === "rework" ? "（含保留资料）" : ""}；支持 JPG、PNG、WebP、PDF。
      {limits !== null ? `单份上限 ${Number((limits / 1024 / 1024).toFixed(3))} MiB。` : failed ? "文件大小限制读取失败。" : "正在读取文件大小限制…"}
      {count >= PATTERN_MATERIAL_LIMIT ? "已达上限，请先移除不需要的资料。" : ""}
    </p>
    {failed && <Button type="button" disabled={disabled} onClick={() => setRetry(value => value + 1)}>重读上传限制</Button>}
  </div>;
}
