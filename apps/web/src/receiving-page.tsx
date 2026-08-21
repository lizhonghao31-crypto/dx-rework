import { Button, Surface } from "@dx-rework/ui";
import { useEffect, useMemo, useRef, useState } from "react";

import { createWebUrls } from "../url-contract.js";
import "./receiving-page.css";

const { apiUrl } = createWebUrls(import.meta.env.BASE_URL);

type StyleOptions = Readonly<{ styles: readonly string[] }>;
type Receipt = Readonly<{
  receiptId: string;
  styleNo: string;
  documentQuantity: number;
  actualQuantity: number;
  differenceQuantity: number;
  receivedAt: string;
}>;

const errorMessage = async (response: Response): Promise<string> => {
  const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
  return body?.error?.message ?? "提交失败，请稍后重试";
};

export function ReceivingPage() {
  const [open, setOpen] = useState(false);
  const [styles, setStyles] = useState<readonly string[]>([]);
  const [styleNo, setStyleNo] = useState("");
  const [documentQuantity, setDocumentQuantity] = useState("");
  const [actualQuantity, setActualQuantity] = useState("");
  const [styleMenuOpen, setStyleMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const pendingKey = useRef<string | null>(null);

  const loadStyles = async () => {
    const response = await fetch(apiUrl("receiving/style-options"), { credentials: "include" });
    if (!response.ok) return;
    const body = await response.json() as StyleOptions;
    setStyles(body.styles);
  };

  useEffect(() => { void loadStyles(); }, []);

  const matches = useMemo(() => {
    const needle = styleNo.trim().toLocaleLowerCase("zh-CN");
    if (!needle) return styles.slice(0, 10);
    return styles.filter((item) => item.toLocaleLowerCase("zh-CN").includes(needle)).slice(0, 10);
  }, [styleNo, styles]);

  const submit = async () => {
    const trimmedStyle = styleNo.trim();
    const documentCount = Number(documentQuantity);
    const actualCount = Number(actualQuantity);
    if (!trimmedStyle) { setMessage("请选择或填写款号"); return; }
    if (!/^\d+$/.test(documentQuantity) || documentCount <= 0) { setMessage("收货单数量请输入大于0的整数"); return; }
    if (!/^\d+$/.test(actualQuantity) || actualCount < 0) { setMessage("实际收货数量请输入大于等于0的整数"); return; }

    setBusy(true);
    setMessage("");
    try {
      const key = pendingKey.current ?? crypto.randomUUID();
      pendingKey.current = key;
      const response = await fetch(apiUrl("receiving/receipts"), {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json", "idempotency-key": key },
        body: JSON.stringify({ styleNo: trimmedStyle, documentQuantity: documentCount, actualQuantity: actualCount }),
      });
      if (!response.ok) throw new Error(await errorMessage(response));
      const receipt = await response.json() as Receipt;
      pendingKey.current = null;
      const sign = receipt.differenceQuantity > 0 ? "+" : "";
      setMessage(`收货成功 · 差异 ${sign}${receipt.differenceQuantity} 件`);
      setStyleNo("");
      setDocumentQuantity("");
      setActualQuantity("");
      setStyleMenuOpen(false);
      setOpen(false);
      void loadStyles();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "提交失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  };

  return <main className="receiving-shell">
    <section className="receiving-hero">
      <div className="receiving-brand">达兴 · 仓库收货</div>
      {!open ? (
        <button className="receiving-start" type="button" onClick={() => { setOpen(true); setMessage(""); }}>
          <span aria-hidden="true">＋</span>
          <strong>点击收货</strong>
        </button>
      ) : (
        <Surface className="receiving-form-card">
          <h1>收货</h1>
          <label className="receiving-field">
            <span>款号</span>
            <div className="receiving-style-input">
              <input
                type="search"
                autoComplete="off"
                inputMode="text"
                placeholder="搜索或填写款号"
                value={styleNo}
                disabled={busy}
                onFocus={() => setStyleMenuOpen(true)}
                onBlur={() => window.setTimeout(() => setStyleMenuOpen(false), 120)}
                onChange={(event) => { setStyleNo(event.target.value); setStyleMenuOpen(true); }}
              />
              {styleMenuOpen && matches.length > 0 ? <div className="receiving-style-menu" role="listbox">
                {matches.map((item) => <button
                  type="button"
                  key={item}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => { setStyleNo(item); setStyleMenuOpen(false); }}
                >{item}</button>)}
              </div> : null}
            </div>
          </label>
          <label className="receiving-field">
            <span>收货单数量</span>
            <input type="number" min="1" step="1" inputMode="numeric" placeholder="0" value={documentQuantity} disabled={busy} onChange={(event) => setDocumentQuantity(event.target.value)} />
          </label>
          <label className="receiving-field">
            <span>实际收货数量</span>
            <input type="number" min="0" step="1" inputMode="numeric" placeholder="0" value={actualQuantity} disabled={busy} onChange={(event) => setActualQuantity(event.target.value)} />
          </label>
          <Button variant="primary" className="receiving-submit" disabled={busy} onClick={() => void submit()}>{busy ? "提交中…" : "提交收货"}</Button>
          <button className="receiving-cancel" type="button" disabled={busy} onClick={() => setOpen(false)}>返回</button>
        </Surface>
      )}
      {message ? <p className="receiving-message" role="status">{message}</p> : null}
    </section>
  </main>;
}
