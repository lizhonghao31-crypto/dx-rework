import { useEffect, useRef, useState } from "react";
import { Button, Surface } from "@dx-rework/ui";
import { BUDGET_SECTIONS, BudgetDocumentSchema, budgetDisplayAmount, calculateBudget, type BudgetDocument, type BudgetRow, type BudgetSheet } from "@dx-rework/contracts/digital-budget";
import type { DigitalOrder } from "@dx-rework/contracts/digital-production";
import type { UploadIntentResponse } from "@dx-rework/contracts";
import { digitalRequest } from "./digital-production-api.js";
import { createClientRequestId } from "./client-request-id.js";
import { sha256Hex } from "./attachment-upload.js";
import { confirmInApp } from "./system-dialog.js";
import { createWebUrls } from "../url-contract.js";
import "./digital-budget.css";

const urls = createWebUrls(import.meta.env.BASE_URL);
const newRow = (section: BudgetRow["section"], category = ""): BudgetRow => ({ rowId: createClientRequestId(), section, category, name: "", specification: "", unit: "", supplier: "", consumption: "", unitPrice: "" });
const initial = (): BudgetDocument => ({ fabricType: "", productCategory: "", monthSeries: "", date: null, currency: "人民币", freight: "", cm: "", salePrice: "", outsourcingScope: "", outsourcingUnitPrice: "", imageAttachmentIds: [],
  rows: [...Array.from({ length: 5 }, () => newRow("主料", "面料")), ...Array.from({ length: 2 }, () => newRow("主料", "里料")),
    ...[...Array<string>(6).fill("通用物料"), ...Array<string>(3).fill("拉链"), ...Array<string>(3).fill("扣类"), ...Array<string>(3).fill("橡筋类"), ...Array<string>(3).fill("装饰牌标"), ...Array<string>(4).fill("花边/织带"), ...Array<string>(3).fill("其它")].map(category => newRow("辅料", category)),
    ...Array.from({ length: 4 }, () => newRow("外发工序"))] });
const columns = { category: "类型", name: "物料或工序", specification: "规格", unit: "单位", supplier: "供应方", consumption: "单件用量", unitPrice: "单价不含税" } as const;
export function DigitalBudgetPanel({ order, onClose }: { order: DigitalOrder; onClose: () => void }) {
  const [sheet, setSheet] = useState<BudgetSheet | null>(null), [doc, setDoc] = useState<BudgetDocument>(initial);
  const [busy, setBusy] = useState(false), [dirty, setDirty] = useState(false), [error, setError] = useState("");
  const writing = useRef(false), operation = useRef<{ payload: string; key: string } | null>(null);
  const base = `orders/${order.productionOrderId}/budget`;
  useEffect(() => { let live = true; void digitalRequest<BudgetSheet>(base).then(value => { if (live) { setSheet(value); setDoc(value.document ?? initial()); } }).catch(reason => { if (live) setError(reason.message); }); return () => { live = false; }; }, [base]);
  const edit = (patch: Partial<BudgetDocument>) => { setDoc(current => ({ ...current, ...patch })); setDirty(true); };
  const changeRow = (rowId: string, patch: Partial<BudgetRow>) => edit({ rows: doc.rows.map(row => row.rowId === rowId ? { ...row, ...patch } : row) });
  const run = async (publish: boolean) => {
    if (!sheet || writing.current) return;
    writing.current = true; setBusy(true); setError("");
    const body = publish ? { expectedVersion: sheet.version } : { expectedVersion: sheet.version, document: doc };
    const path = `${base}${publish ? "/publish" : ""}`, payload = JSON.stringify([path, body]);
    if (operation.current?.payload !== payload) operation.current = { payload, key: createClientRequestId() };
    try { const value = await digitalRequest<BudgetSheet>(path, publish ? "POST" : "PUT", body, operation.current.key); setSheet(value); setDoc(value.document!); setDirty(false); operation.current = null; }
    catch (reason) { setError(reason instanceof Error ? reason.message : "预算操作失败"); }
    finally { writing.current = false; setBusy(false); }
  };
  const upload = async (files: File[]) => {
    if (!files.length || writing.current) return;
    writing.current = true; setBusy(true); setError("");
    try {
      if (doc.imageAttachmentIds.length + files.length > 8) throw Error("预算图片最多8张");
      const limits = await digitalRequest<{ maxUploadBytes: number }>(`${base}/upload-limits`);
      for (const file of files) {
        if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) throw Error("请上传 JPG、PNG 或 WebP 图片");
        if (file.size > limits.maxUploadBytes) throw Error(`${file.name}超过上传大小限制`);
        const intent = await digitalRequest<UploadIntentResponse>(`${base}/upload-intents`, "POST", { filename: file.name, mimeType: file.type, sizeBytes: file.size, sha256: await sha256Hex(file) });
        const form = new FormData(); for (const [name, value] of Object.entries(intent.uploadFields)) form.append(name, value); form.append("file", file);
        const response = await fetch(intent.uploadUrl, { method: intent.uploadMethod, body: form, credentials: "omit" });
        if (!response.ok) throw Error(`${file.name}上传失败`);
        await digitalRequest(`${base}/attachments/${intent.attachmentId}/finalize`, "POST", {});
        setDoc(current => ({ ...current, imageAttachmentIds: [...current.imageAttachmentIds, intent.attachmentId] })); setDirty(true);
      }
    } catch (reason) { setError(reason instanceof Error ? reason.message : "上传失败"); }
    finally { writing.current = false; setBusy(false); }
  };
  const valid = BudgetDocumentSchema.safeParse(doc), totals = valid.success ? calculateBudget(valid.data) : null;
  const amount = (value: string | null | undefined) => value == null ? "—" : budgetDisplayAmount(value);
  const field = (key: "fabricType" | "productCategory" | "monthSeries" | "freight" | "cm" | "salePrice" | "outsourcingScope" | "outsourcingUnitPrice", label: string, numeric = false) => <label>{label}<input aria-label={label} inputMode={numeric ? "decimal" : "text"} maxLength={numeric ? 21 : key === "outsourcingScope" ? 1000 : 100} value={doc[key]} onChange={event => edit({ [key]: event.target.value })} /><span className="budget-print-value">{doc[key] || "—"}</span></label>;
  return <Surface><section className="budget-editor">
    <div className="pattern-actions budget-controls"><Button disabled={busy} onClick={async () => { if (!dirty || await confirmInApp("有未保存修改，确定离开？")) onClose(); }}>返回</Button><Button disabled={!sheet?.document || dirty || busy} onClick={() => window.print()}>打印 / 保存 PDF</Button><span>{sheet?.status === "published" ? "已发布" : "草稿"}{sheet?.version ? ` · 版本 ${sheet.version}` : ""}</span></div>
    {error && <p role="alert">{error}</p>}
    {sheet?.canSubmitSourcing && !dirty && <a className="dx-button dx-button--secondary budget-controls" href={`${urls.pageUrl("ui/sourcing/create")}?budget=${order.productionOrderId}&budgetVersion=${sheet.version}`}>核实并发起外发</a>}
    {sheet?.sourcingCaseId && <a className="dx-button dx-button--secondary budget-controls" href={urls.pageUrl(`ui/sourcing/orders/${sheet.sourcingCaseId}`)}>查看外发订单</a>}
    {sheet && <form onSubmit={event => { event.preventDefault(); void run(false); }}><fieldset disabled={!sheet.canEdit || busy}>
      <header><h2>广州市达兴制衣有限公司</h2><h3>成本预算表</h3></header>
      <div className="budget-heading"><span>产品性别：{order.productGroup}</span>{field("fabricType", "面料属性")}{field("productCategory", "产品类别")}<span>{order.productGroup}{doc.fabricType}{doc.productCategory}</span><span>设计师：{sheet.designerName}</span>{field("monthSeries", "月份系列")}<span>设计款号：{order.designStyleNo}</span><span>客户：{order.customerCode}</span></div>
      <div className="budget-images">{doc.imageAttachmentIds.map(id => <div key={id}>{sheet.document?.imageAttachmentIds.includes(id) ? <img alt="预算款图" src={urls.apiUrl(`digital-production/${base}/attachments/${id}`)} /> : <span>图片已上传，保存后预览</span>}{sheet.canEdit && <Button className="budget-controls" type="button" onClick={() => edit({ imageAttachmentIds: doc.imageAttachmentIds.filter(item => item !== id) })}>移除</Button>}</div>)}</div>
      {sheet.canEdit && <label className="budget-controls">上传图片<input type="file" multiple accept="image/jpeg,image/png,image/webp" onChange={event => { const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ""; void upload(files); }} /></label>}
      <table><thead><tr><th>款号</th><th>PO号</th><th>颜色</th><th>件数</th></tr></thead><tbody>{order.lines.map(line => <tr key={line.lineId}><td>{line.formalStyleNo || line.temporaryStyleNo || order.temporaryStyleNo || order.designStyleNo}</td><td>{line.poNumber || "—"}</td><td>{line.color}</td><td>{line.sizes.reduce((sum, size) => sum + size.quantity, 0).toLocaleString()}</td></tr>)}</tbody></table>
      {BUDGET_SECTIONS.map(section => <section key={section}><h4>{section}</h4><div className="budget-table-scroll"><table><thead><tr>{Object.values(columns).map(label => <th key={label}>{label}</th>)}<th>金额</th>{sheet.canEdit && <th className="budget-controls">操作</th>}</tr></thead>
        <tbody>{doc.rows.filter(row => row.section === section).map(row => <tr key={row.rowId}>{(Object.keys(columns) as Array<keyof typeof columns>).map(key => <td key={key}><input aria-label={`${section} ${columns[key]}`} value={row[key]} inputMode={key === "consumption" || key === "unitPrice" ? "decimal" : "text"} maxLength={key === "consumption" || key === "unitPrice" ? 21 : 100} onChange={event => changeRow(row.rowId, { [key]: event.target.value })} /><span className="budget-print-value">{row[key]}</span></td>)}<td>{amount(totals?.rows.find(item => item.rowId === row.rowId)?.amount)}</td>{sheet.canEdit && <td className="budget-controls"><Button type="button" onClick={() => edit({ rows: doc.rows.filter(item => item.rowId !== row.rowId) })}>删除</Button></td>}</tr>)}</tbody>
        <tfoot><tr><th colSpan={7}>{section}合计</th><td>{amount(totals?.[section === "主料" ? "main" : section === "辅料" ? "accessories" : "processes"])}</td>{sheet.canEdit && <td className="budget-controls" />}</tr></tfoot></table></div>
        {sheet.canEdit && <Button className="budget-controls" type="button" disabled={doc.rows.length >= 300} onClick={() => edit({ rows: [...doc.rows, newRow(section)] })}>添加{section}</Button>}</section>)}
      <div className="budget-summary">{field("freight", "运费", true)}{field("cm", "CM加工费用（裁、车、烫、包装）", true)}<p>成本合计（不含税）：{amount(totals?.cost)}</p>{field("salePrice", "销售单价（不含税，人民币）", true)}<p>利润：{amount(totals?.profit)}</p>{field("outsourcingScope", "本次实际外发范围")}{field("outsourcingUnitPrice", "本次实际外发预算价", true)}</div>
      <footer><span>业务跟单：{sheet.merchandiserName || "待指派"}</span><label>日期<input type="date" value={doc.date ?? ""} onChange={event => edit({ date: event.target.value || null })} /><span className="budget-print-value">{doc.date || "—"}</span></label></footer>
      {sheet.canEdit && <div className="pattern-actions budget-controls"><Button type="submit" disabled={busy}>保存预算</Button><Button type="button" disabled={busy || dirty || !sheet.version || sheet.status === "published"} onClick={() => void run(true)}>发布预算</Button></div>}
    </fieldset></form>}
  </section></Surface>;
}
