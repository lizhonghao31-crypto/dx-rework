import { useEffect, useId, useRef, useState } from "react";

export function PageJump({ page, totalPages, onPage, busy = false }: {
  page: number;
  totalPages: number | null;
  onPage(page: number): void;
  busy?: boolean;
}) {
  const [input, setInput] = useState(String(page));
  const [error, setError] = useState("");
  const composing = useRef(false);
  const errorId = useId();
  const disabled = busy || totalPages === null || totalPages <= 1;
  useEffect(() => {
    setInput(String(page));
    setError("");
  }, [page, totalPages]);

  const jump = () => {
    if (disabled) return;
    const value = input.trim();
    const target = Number(value);
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(target) || target < 1 || target > totalPages) {
      setError(`请输入 1 至 ${totalPages} 的整数页码`);
      return;
    }
    setError("");
    if (target !== page) onPage(target);
  };

  return (
    <div className="dx-page-jump">
      <input type="text" inputMode="numeric" aria-label="跳转页码"
        disabled={disabled} value={input}
        aria-invalid={Boolean(error)} aria-describedby={error ? errorId : undefined}
        onChange={event => { setInput(event.currentTarget.value); setError(""); }}
        onCompositionStart={() => { composing.current = true; }}
        onCompositionEnd={() => { composing.current = false; }}
        onKeyDown={event => {
          if (event.key !== "Enter") return;
          event.stopPropagation();
          event.preventDefault();
          if (composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
          jump();
        }} />
      <button type="button" disabled={disabled} onClick={jump}>跳转</button>
      {error && <span id={errorId} role="status">{error}</span>}
    </div>
  );
}
