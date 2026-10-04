import { validateXlsxResourceBudget } from "./xlsx-resource-budget.js";
import { useEffect, useRef, useState } from "react";
import { Button, StatusBadge, Surface } from "@dx-rework/ui";
import { SupplierBatchPreviewSchema, type SupplierBatchRow, type SupplierBatchValue } from "@dx-rework/contracts";
import { createWebUrls } from "../url-contract.js";
import { createClientRequestId } from "./client-request-id.js";
import { registerInternalNavigationGuard } from "./internal-navigation.js";
import { confirmInApp } from "./system-dialog.js";
import { createSupplierDraftGuard } from "./supplier-draft-guard.js";
import { SupplierImportRequestError } from "./supplier-import-safety.js";
import { canSubmitSupplierBatchEntry, executeSupplierBatch, summarizeSupplierBatch, type SupplierBatchEntry } from "./supplier-batch-client.js";
import "./supplier-batch-panel.css";

const { apiUrl } = createWebUrls(import.meta.env.BASE_URL);
const labels: Record<SupplierBatchRow["status"], string> = { create: "新增", supplement: "补全", review: "待确认", unchanged: "无变化", conflict: "冲突", error: "失败" };
const display = (value: SupplierBatchValue) => value === null || value === "" ? "空" : Array.isArray(value) ? value.join("、") : typeof value === "boolean" ? value ? "启用" : "停用" : String(value);
async function request<T>(path: string, body: unknown, key?: string): Promise<T> {
  const response = await fetch(apiUrl(path), { method: "POST", credentials: "include", headers: { "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) }, body: JSON.stringify(body) });
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new SupplierImportRequestError(result?.error?.message ?? "批量录入请求失败", response.status);
  if (!result) throw new Error("响应未确认，请按原请求重试");
  return result as T;
}

export function SupplierBatchPanel({ onClose, onChanged }: { onClose: () => void; onChanged: () => Promise<void> }) {
  const [entries, setEntries] = useState<SupplierBatchEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [filename, setFilename] = useState("");
  const [error, setError] = useState("");
  const [executed, setExecuted] = useState(false);
  const lock = useRef(false);
  const entriesRef = useRef(entries);
  const [guard] = useState(() => createSupplierDraftGuard({
    isBlocked: () => lock.current,
    confirm: () => confirmInApp("批量录入还有未完成的行，确定离开？已保存的资料会保留。", { title: "离开批量录入", confirmLabel: "离开", cancelLabel: "继续处理" }),
    discard: () => { entriesRef.current = []; setEntries([]); },
  }));
  guard.setDirty(entries.some(entry => ["create", "supplement", "review"].includes(entry.plan.status) && entry.result?.status !== "success"));
  useEffect(() => {
    const unregister = registerInternalNavigationGuard(guard.requestLeave);
    const unload = (event: BeforeUnloadEvent) => { if (guard.shouldBlock) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", unload);
    return () => { unregister(); window.removeEventListener("beforeunload", unload); };
  }, [guard]);
  const replace = (next: SupplierBatchEntry[]) => { entriesRef.current = next; setEntries(next); };
  const readFile = async (file: File | undefined) => {
    if (!file || lock.current || !await guard.requestLeave() || lock.current) return;
    if (!/\.xlsx$/i.test(file.name) || file.size > 2 * 1024 * 1024) { setError("请选择一个不超过 2 MB 的 .xlsx 文件"); return; }
    lock.current = true; setBusy(true); setError(""); replace([]); setFilename(file.name); setExecuted(false);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      await validateXlsxResourceBudget(bytes);
      const { readSheet } = await import("read-excel-file/browser");
      const cells = await readSheet(new Blob([bytes]), "供应商录入");
      const parsed = SupplierBatchPreviewSchema.safeParse({ rows: cells });
      if (!parsed.success) throw new Error("文件须包含表头和最多 200 行资料、15 列；请检查是否误填了日期或超长内容");
      const plans = await request<SupplierBatchRow[]>("master-data/suppliers/import/preview", parsed.data);
      replace(plans.map(plan => ({ plan, confirmedFields: [] })));
      if (!plans.length) setError("文件没有供应商资料，请在第二行开始填写");
    } catch (failure) { setError(failure instanceof Error && /[\u3400-\u9fff]/.test(failure.message) ? failure.message : "文件读取失败，请使用标准模板的“供应商录入”页"); }
    finally { lock.current = false; setBusy(false); }
  };
  const submit = async () => {
    if (lock.current || guard.pending || !entriesRef.current.some(canSubmitSupplierBatchEntry)) return;
    lock.current = true; setBusy(true); setError(""); setExecuted(true);
    try {
      await executeSupplierBatch(entriesRef.current, (body, key) => request("master-data/suppliers/import/rows", body, key), entry => {
        replace(entriesRef.current.map(current => current.plan.rowNumber === entry.plan.rowNumber ? entry : current));
      }, () => createClientRequestId());
      await onChanged();
    } catch { setError("结果已保留，目录刷新失败；请稍后刷新核对"); }
    finally { lock.current = false; setBusy(false); }
  };
  const actionable = entries.filter(canSubmitSupplierBatchEntry).length;
  const outcome = summarizeSupplierBatch(entries);
  return <Surface className="supplier-batch">
    <div className="supplier-batch__heading"><div><h2>批量录入供应商</h2><p>识别已有供应商，补齐空资料；已有值变化由你确认。</p></div><Button disabled={busy} onClick={() => void guard.requestLeave().then(ok => { if (ok) onClose(); })}>返回资料维护</Button></div>
    <ol className="supplier-batch__steps" aria-label="批量录入步骤">{["下载模板", "上传文件", "校验结果", "确认导入"].map((step, index) => <li key={step} aria-current={index === (executed ? 3 : entries.length ? 2 : filename ? 1 : 0) ? "step" : undefined}>{index + 1} {step}</li>)}</ol>
    <div className="supplier-batch__tools"><a className="dx-button dx-button--secondary" href={apiUrl("master-data/suppliers/import/template.xlsx")} download>下载 .xlsx 模板</a><label>上传文件<input type="file" accept=".xlsx" disabled={busy} onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; void readFile(file); }} /></label></div>
    <p className="supplier-batch__hint">空单元格保留旧资料；工艺自动合并。收款账号须用文本填写。一次最多 200 行、2 MB。</p>
    {filename ? <p>{filename}{busy ? " · 处理中…" : ""}</p> : null}
    {error ? <p role="alert" className="supplier-batch__error">{error}</p> : null}
    {entries.length ? <>
      <div className="supplier-batch__summary" role="status"><span>预检</span>{Object.entries(labels).map(([status, label]) => <span key={status}>{label} {entries.filter(entry => entry.plan.status === status).length}</span>)}</div>
      {executed ? <div className="supplier-batch__summary" role="status"><span>本次结果</span><span>共 {outcome.total} 行</span><span>新增成功 {outcome.created}</span><span>补全成功 {outcome.supplemented}</span><span>确认更新成功 {outcome.confirmedUpdates}</span><span>无变化 {outcome.unchanged}</span><span>失败 {outcome.failed}</span>{outcome.pending ? <span>待处理 {outcome.pending}</span> : null}</div> : null}
      <p className="supplier-batch__hint">补全空值和工艺合并会自动执行。勾选“原值 → 新值”才覆盖该字段，未勾选的旧值保留。</p>
      <div className="supplier-batch__rows">{entries.map(entry => <article key={entry.plan.rowNumber}>
        <div className="supplier-batch__row-heading"><strong>第 {entry.plan.rowNumber} 行 · {entry.plan.supplierName || "未填写名称"}</strong><StatusBadge tone={["error", "conflict"].includes(entry.plan.status) || entry.result?.status === "failed" ? "warning" : entry.result?.status === "success" ? "success" : "neutral"}>{entry.result?.status === "success" ? "已保存" : labels[entry.plan.status]}</StatusBadge></div>
        <p>{entry.plan.supplierCode}{entry.plan.version ? ` · 当前版本 ${entry.plan.version}` : ""} · {entry.plan.message}</p>
        {entry.plan.changes.length ? <details open={entry.plan.status === "review"}><summary>查看 {entry.plan.changes.length} 项字段变化</summary><div className="supplier-batch__changes">{entry.plan.changes.map(change => <label key={change.field}>
          {change.needsConfirmation ? <input type="checkbox" disabled={busy || Boolean(entry.request)} checked={entry.confirmedFields.includes(change.field)} onChange={event => replace(entriesRef.current.map(current => current.plan.rowNumber !== entry.plan.rowNumber ? current : { ...current, confirmedFields: event.target.checked ? [...current.confirmedFields, change.field] : current.confirmedFields.filter(field => field !== change.field) }))} /> : <span>自动补充</span>}
          <b>{change.label}</b><span>{display(change.before)} → {display(change.after)}</span>
        </label>)}</div></details> : null}
        {entry.result ? <p role="status">{entry.result.message}</p> : null}
      </article>)}</div>
      <div className="supplier-batch__actions"><Button variant="primary" disabled={busy || !actionable} onClick={() => void submit()}>{busy ? "处理中…" : executed ? `继续 / 重试（${actionable} 行）` : `确认导入（${actionable} 行）`}</Button></div>
    </> : null}
  </Surface>;
}
