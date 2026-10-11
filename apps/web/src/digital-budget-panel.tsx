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
import { DocumentTableScroll, DocumentAddRow, DocumentAnchors, DocumentErrors, DocumentField, DocumentSection, DocumentToolbar } from "./document-editor.js";
import { budgetColumns as columns, budgetFieldLabels, budgetIssues } from "./digital-budget-validation.js";
import { DigitalBudgetPrint } from "./digital-budget-print.js";
import { NavigationIcon } from "./navigation-icons.js";
import { useDigitalDetailNavigationGuard } from "./use-digital-detail-navigation-guard.js";
import "./digital-budget.css";

const urls = createWebUrls(import.meta.env.BASE_URL);
const newRow = (section: BudgetRow["section"], category = ""): BudgetRow => ({ rowId: createClientRequestId(), section, category, name: "", specification: "", unit: "", supplier: "", consumption: "", unitPrice: "" });
const initial = (): BudgetDocument => ({ fabricType: "", productCategory: "", monthSeries: "", date: null, currency: "人民币", freight: "", cm: "", salePrice: "", outsourcingScope: "", outsourcingUnitPrice: "", imageAttachmentIds: [],
  rows: [...Array.from({ length: 5 }, () => newRow("主料", "面料")), ...Array.from({ length: 2 }, () => newRow("主料", "里料")),
    ...[...Array<string>(6).fill("通用物料"), ...Array<string>(3).fill("拉链"), ...Array<string>(3).fill("扣类"), ...Array<string>(3).fill("橡筋类"), ...Array<string>(3).fill("装饰牌标"), ...Array<string>(4).fill("花边/织带"), ...Array<string>(3).fill("其它")].map(category => newRow("辅料", category)),
    ...Array.from({ length: 4 }, () => newRow("外发工序"))] });

export function DigitalBudgetPanel({ order, onClose, initialVersion }: { order: DigitalOrder; onClose: () => void; initialVersion?: number | undefined }) {
  const [sheet, setSheet] = useState<BudgetSheet | null>(null), [doc, setDoc] = useState<BudgetDocument>(initial);
  const [busy, setBusy] = useState(false), [dirty, setDirty] = useState(false), [error, setError] = useState("");
  const writing = useRef(false), operation = useRef<{ payload: string; key: string } | null>(null);
  const confirmingCopy = useRef(false);
  const root = useRef<HTMLElement>(null), templateDefaults = useRef(new Map<string,string>()), completedUploads = useRef(new Map<string,string>());
  const [activated, setActivated] = useState(new Set<string>()), [showTemplates, setShowTemplates] = useState(false), [validationMode, setValidationMode] = useState<"save"|"publish"|null>(null);
  const [summaryFits,setSummaryFits]=useState(false);
  const install = (value:BudgetSheet) => { const next=value.document??initial(); templateDefaults.current=new Map(value.document?[]:next.rows.map(row=>[row.rowId,row.category]));setActivated(new Set());setSheet(value);setDoc(next);setDirty(false);setValidationMode(null); };
  const base = `orders/${order.productionOrderId}/budget`;
  useEffect(() => { let live = true; void digitalRequest<BudgetSheet>(`${base}${initialVersion?`?version=${initialVersion}`:""}`).then(value => { if (live) { install(value); } }).catch(reason => { if (live) setError(reason.message); }); return () => { live = false; }; }, [base,initialVersion]);
  useDigitalDetailNavigationGuard(dirty,busy,writing,"有未保存修改，确定离开？");

  useEffect(()=>{const element=root.current?.querySelector<HTMLElement>(".budget-document-summary");if(!element)return;const measure=()=>{const toolbar=root.current?.querySelector(".dx-doc-toolbar");setSummaryFits(element.getBoundingClientRect().height+(toolbar?.getBoundingClientRect().height??0)+32<=window.innerHeight);};const observer=new ResizeObserver(measure);observer.observe(element);window.addEventListener("resize",measure);measure();return()=>{observer.disconnect();window.removeEventListener("resize",measure);};},[Boolean(sheet)]);
  const edit = (patch: Partial<BudgetDocument>) => { setDoc(current => ({ ...current, ...patch })); setDirty(true); };
  const changeRow = (rowId: string, patch: Partial<BudgetRow>) => {setActivated(current=>new Set([...current,rowId]));edit({ rows: doc.rows.map(row => row.rowId === rowId ? { ...row, ...patch } : row) });};
  const run = async (publish: boolean, copyPublished = false) => {
    if (!sheet || !sheet.canEdit || writing.current || (sheet.status==="published"&&!copyPublished)) return;
    if(copyPublished&&(publish||sheet.status!=="published"||initialVersion!==undefined||!sheet.document))return;
    const saveDocument=copyPublished?sheet.document!:doc;
    setValidationMode(publish?"publish":"save");
    const problems=budgetIssues(saveDocument,publish);if(problems.length){setError("");requestAnimationFrame(()=>document.getElementById(problems[0]!.id)?.focus());return;}
    writing.current = true; setBusy(true); setError("");
    const write=async(path:string,method:string,body:unknown)=>{
      const payload=JSON.stringify([path,body]);if(operation.current?.payload!==payload)operation.current={payload,key:createClientRequestId()};
      const value=await digitalRequest<BudgetSheet>(path,method,body,operation.current.key);operation.current=null;return value;
    };
    try {
      let value=sheet;
      if(!publish||dirty||!sheet.document){
        value=await write(base,"PUT",{expectedVersion:sheet.version,document:saveDocument});
        setSheet(value);setDoc(value.document!);setDirty(false);
      }
      if(publish)value=await write(`${base}/publish`,"POST",{expectedVersion:value.version});
      setSheet(value);setDoc(value.document!);setDirty(false);
    }
    catch (reason) { setError(reason instanceof Error ? reason.message : "预算操作失败"); }
    finally { writing.current = false; setBusy(false); }
  };
  const copyPublished = async () => {
    if(!sheet?.canEdit||sheet.status!=="published"||initialVersion!==undefined||writing.current||confirmingCopy.current)return;
    confirmingCopy.current=true;
    try{if(await confirmInApp("另存为新草稿？当前已发布版本及历史图片保持不变，新草稿修改后须单独发布。",{confirmLabel:"另存为新草稿"}))await run(false,true);}
    finally{confirmingCopy.current=false;}
  };
  const upload = async (files: File[]) => {
    if (!files.length || writing.current) return;
    writing.current = true; setBusy(true); setError("");
    try {
      const associated=new Set(doc.imageAttachmentIds);
      const limits = await digitalRequest<{ maxUploadBytes: number }>(`${base}/upload-limits`);
      for (const file of files) {
        if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) throw Error("请上传 JPG、PNG 或 WebP 图片");
        if (file.size > limits.maxUploadBytes) throw Error(`${file.name}超过上传大小限制`);
        const fingerprint=`${file.name}:${file.size}:${await sha256Hex(file)}`;
        const prior=completedUploads.current.get(fingerprint);if(prior&&associated.has(prior))continue;
        if(associated.size>=8)throw Error("预算图片最多8张");
        const intent = await digitalRequest<UploadIntentResponse>(`${base}/upload-intents`, "POST", { filename: file.name, mimeType: file.type, sizeBytes: file.size, sha256: fingerprint.slice(fingerprint.lastIndexOf(":")+1) });
        const form = new FormData(); for (const [name, value] of Object.entries(intent.uploadFields)) form.append(name, value); form.append("file", file);
        const response = await fetch(intent.uploadUrl, { method: intent.uploadMethod, body: form, credentials: "omit" });
        if (!response.ok) throw Error(`${file.name}上传失败`);
        await digitalRequest(`${base}/attachments/${intent.attachmentId}/finalize`, "POST", {});
        completedUploads.current.set(fingerprint,intent.attachmentId);associated.add(intent.attachmentId);
        setDoc(current => ({ ...current, imageAttachmentIds: [...current.imageAttachmentIds, intent.attachmentId] })); setDirty(true);
      }
    } catch (reason) { setError(reason instanceof Error ? reason.message : "上传失败"); }
    finally { writing.current = false; setBusy(false); }
  };
  const valid = BudgetDocumentSchema.safeParse(doc), totals = valid.success ? calculateBudget(valid.data) : null;
  const amount = (value: string | null | undefined) => value == null ? "—" : budgetDisplayAmount(value);
  const readonly=!sheet?.canEdit||sheet.status==="published", issues=validationMode?budgetIssues(doc,validationMode==="publish"):[];
  const issue=(id:string)=>issues.find(item=>item.id===id)?.message;
  const field = (key: keyof typeof budgetFieldLabels, numeric=false) => {const id=`budget-${key}`,label=budgetFieldLabels[key]!;return <label>{label}<DocumentField id={id} label={label} value={String(doc[key as keyof BudgetDocument]??"")} onValue={value=>edit({[key]:key==="date"?(value||null):value})} readonly={readonly} disabled={busy} numeric={numeric} multiline={key==="outsourcingScope"} type={key==="date"?"date":"text"} maxLength={numeric?21:key==="outsourcingScope"?1000:100} issue={issue(id)} onBlur={numeric?()=>setValidationMode("save"):undefined}/></label>;};
  const unused=(row:BudgetRow)=>templateDefaults.current.has(row.rowId)&&row.category===templateDefaults.current.get(row.rowId)&&!activated.has(row.rowId)&&[row.name,row.specification,row.unit,row.supplier,row.consumption,row.unitPrice].every(value=>value==="");
  const addRow=(section:BudgetRow["section"])=>{const spare=doc.rows.find(row=>row.section===section&&unused(row));const row=spare??newRow(section);if(!spare)edit({rows:[...doc.rows,row]});setActivated(current=>new Set([...current,row.rowId]));requestAnimationFrame(()=>document.getElementById(`budget-${row.rowId}-category`)?.focus());};
  const removeRow=async(row:BudgetRow)=>{if(!unused(row)&&Object.keys(columns).some(key=>Boolean(row[key as keyof typeof columns]))&&!await confirmInApp("删除这条预算明细？已保存的历史版本不受影响。"))return;edit({rows:doc.rows.filter(item=>item.rowId!==row.rowId)});};
  const reload=async()=>{if(writing.current||dirty&&!await confirmInApp("重新载入将丢弃未保存修改，确定继续？"))return;setBusy(true);try{install(await digitalRequest<BudgetSheet>(`${base}${initialVersion?`?version=${initialVersion}`:""}`));setError("");}catch(reason){setError(reason instanceof Error?reason.message:"读取失败");}finally{setBusy(false);}};
  return <><Surface><section ref={root} className="budget-editor dx-doc-budget">
    <DocumentToolbar title="成本预算表" status={busy?"保存中":error&&dirty?"保存失败，修改未保存":dirty?"未保存修改":`${initialVersion?"历史版本":sheet?.status==="published"?"已发布 · 当前有效版本":sheet?.version?"已保存":"草稿"}${sheet?.version?` · 版本 ${sheet.version}`:""}`}>
      <Button disabled={busy} onClick={onClose}>返回</Button>
      {sheet?.canEdit&&sheet.status==="published"&&sheet.document&&initialVersion===undefined&&<Button disabled={busy} onClick={()=>void copyPublished()}>另存为新草稿</Button>}
      {!readonly&&<><Button disabled={busy} onClick={()=>void run(false)}>保存预算</Button><Button variant="primary" disabled={busy} onClick={()=>void run(true)}>发布预算</Button></>}
      <Button disabled={!sheet?.document||dirty||busy} onClick={()=>window.print()}>打印 / 保存 PDF</Button>
    </DocumentToolbar>
    <p className="budget-mobile-overview">{order.designStyleNo} · {order.customerCode} · 成本 {amount(totals?.cost)} · 利润 {amount(totals?.profit)}</p>
    <DocumentErrors issues={issues} error={error}/>
    {error&&/更新|版本|冲突/.test(error)&&<Button disabled={busy} onClick={()=>void reload()}>重新载入最新版本</Button>}
    {sheet?.canSubmitSourcing&&initialVersion===undefined&&!dirty&&<a className="dx-button dx-button--secondary budget-controls" href={`${urls.pageUrl("ui/sourcing/create")}?budget=${order.productionOrderId}&budgetVersion=${sheet.version}`}>核实并发起外发</a>}
    {sheet?.sourcingCaseId&&<a className="dx-button dx-button--secondary budget-controls" href={urls.pageUrl(`ui/sourcing/orders/${sheet.sourcingCaseId}`)}>查看外发订单</a>}
    {sheet&&<form onSubmit={event=>{event.preventDefault();void run(false);}}><fieldset disabled={busy}>
      <header className="budget-print-header"><h2>广州市达兴制衣有限公司</h2><h3>成本预算表</h3></header>
      <div className="budget-document-layout">
        <div className="budget-document-main" id="budget-rows" tabIndex={-1}>
          <DocumentSection id="budget-basic" title="基本信息">
            <div className="budget-basic-body"><div className="budget-heading">
              <label>设计款号<span className="dx-doc-readonly">{order.designStyleNo}</span></label><label>客户<span className="dx-doc-readonly">{order.customerCode}</span></label>
              {field("productCategory")}{field("fabricType")}<label>产品性别<span className="dx-doc-readonly">{order.productGroup}</span></label><label>设计师<span className="dx-doc-readonly">{sheet.designerName}</span></label>
              {field("monthSeries")}<label>产品摘要<span className="dx-doc-readonly">{order.productGroup}{doc.fabricType}{doc.productCategory}</span></label>
            </div><div className="budget-images" id="budget-imageAttachmentIds" tabIndex={-1}>
              {!doc.imageAttachmentIds.length&&<div className="budget-image-empty"><NavigationIcon name="Shirt" size="title"/><span>暂无款图</span></div>}
              {doc.imageAttachmentIds.map(id=><div key={id}>{sheet.document?.imageAttachmentIds.includes(id)?<a href={urls.apiUrl(`digital-production/${base}/attachments/${id}`)} target="_blank" rel="noreferrer"><img alt="预算款图" src={urls.apiUrl(`digital-production/${base}/attachments/${id}`)}/></a>:<span>图片已上传，保存后预览</span>}{!readonly&&<Button className="budget-controls" type="button" disabled={busy} onClick={()=>{for(const [key,value] of completedUploads.current)if(value===id)completedUploads.current.delete(key);edit({imageAttachmentIds:doc.imageAttachmentIds.filter(item=>item!==id)});}}>移除</Button>}</div>)}
              {!readonly&&<label className="budget-controls budget-upload">上传图片<input disabled={busy} type="file" multiple accept="image/jpeg,image/png,image/webp" onChange={event=>{const files=Array.from(event.currentTarget.files??[]);event.currentTarget.value="";void upload(files);}}/></label>}
            </div></div>
            <details className="budget-po-summary" open={order.lines.length>0}><summary>款色 / PO · {order.lines.length} 行</summary><DocumentTableScroll><table><thead><tr><th>款号</th><th>PO号</th><th>颜色</th><th>件数</th></tr></thead><tbody>{order.lines.map(line=><tr key={line.lineId}><td>{line.formalStyleNo||line.temporaryStyleNo||order.temporaryStyleNo||order.designStyleNo}</td><td>{line.poNumber||"—"}</td><td>{line.color}</td><td>{line.sizes.reduce((sum,size)=>sum+size.quantity,0).toLocaleString()}</td></tr>)}</tbody></table></DocumentTableScroll></details>
          </DocumentSection>
          <DocumentAnchors sections={[{id:"budget-basic",label:"基本资料"},...BUDGET_SECTIONS.map((section,index)=>({id:`budget-section-${index}`,label:section})),{id:"budget-summary",label:"费用与报价"}]}/>
          {templateDefaults.current.size>0&&<label className="budget-template-toggle budget-controls"><input type="checkbox" checked={showTemplates} onChange={event=>setShowTemplates(event.target.checked)}/>显示未使用模板行（完整保存）</label>}
          {BUDGET_SECTIONS.map((section,index)=>{const visible=doc.rows.filter(row=>row.section===section&&(showTemplates||!unused(row)));return <DocumentSection key={section} id={`budget-section-${index}`} title={section} detail={`共 ${visible.length} 行`}>
            <DocumentTableScroll className="budget-table-scroll"><table className="budget-detail-table"><thead><tr>{Object.values(columns).map(label=><th key={label}>{label}</th>)}<th>金额</th>{!readonly&&<th className="budget-controls">操作</th>}</tr></thead><tbody>
              {doc.rows.filter(row=>row.section===section).map(row=><tr key={row.rowId} data-doc-row={row.rowId} className={!showTemplates&&unused(row)?"budget-template-row":undefined}>{(Object.keys(columns) as Array<keyof typeof columns>).map(key=>{const id=`budget-${row.rowId}-${key}`;return <td key={key}><DocumentField id={id} label={`${section} ${columns[key]}`} value={row[key]} onValue={value=>changeRow(row.rowId,{[key]:value})} readonly={readonly} disabled={busy} numeric={key==="consumption"||key==="unitPrice"} column={key} maxLength={key==="consumption"||key==="unitPrice"?21:100} issue={issue(id)} onBlur={key==="consumption"||key==="unitPrice"?()=>setValidationMode("save"):undefined}/></td>;})}<td className="budget-money">{amount(totals?.rows.find(item=>item.rowId===row.rowId)?.amount)}</td>{!readonly&&<td className="budget-controls"><Button type="button" disabled={busy} aria-label={`删除${section} ${row.name||row.category||"未命名行"}`} onClick={()=>void removeRow(row)}>删除</Button></td>}</tr>)}
              {!visible.length&&<tr><td colSpan={readonly?8:9} className="budget-empty budget-screen-empty">暂无使用明细，可添加{section}。</td></tr>}
            </tbody><tfoot><tr><th colSpan={7}>{section}合计</th><td className="budget-money">{amount(totals?.[section==="主料"?"main":section==="辅料"?"accessories":"processes"])}</td>{!readonly&&<td className="budget-controls"/>}</tr></tfoot></table></DocumentTableScroll>
            {!readonly&&<DocumentAddRow label={`添加${section}`} disabled={busy||doc.rows.length>=300&&!doc.rows.some(row=>row.section===section&&unused(row))} onClick={()=>addRow(section)}/>}
          </DocumentSection>;})}
        </div>
        <div className={`budget-document-summary${summaryFits?" is-sticky":""}`} role="complementary" aria-label="预算汇总">
          <DocumentSection id="budget-summary" title="成本汇总">
            <dl className="budget-totals"><div><dt>主料合计</dt><dd>{amount(totals?.main)}</dd></div><div><dt>辅料合计</dt><dd>{amount(totals?.accessories)}</dd></div><div><dt>外发工序合计</dt><dd>{amount(totals?.processes)}</dd></div></dl>
            {field("freight",true)}{field("cm",true)}<p className="budget-total-highlight">成本合计（不含税）<strong>{amount(totals?.cost)}</strong></p>{field("salePrice",true)}<p className="budget-total-highlight">利润<strong>{amount(totals?.profit)}</strong></p><p className="budget-currency">币种：{doc.currency}</p>
            {!valid.success&&<p className="budget-preview-unavailable">当前输入未通过校验，合计预览不可用。</p>}
          </DocumentSection>
          <DocumentSection id="budget-outsourcing" title="其他信息">{field("outsourcingScope")}{field("outsourcingUnitPrice",true)}<footer><label>业务跟单<span className="dx-doc-readonly">{sheet.merchandiserName||"待指派"}</span></label>{field("date")}</footer></DocumentSection>
        </div>
      </div>
    </fieldset></form>}
  </section></Surface><DigitalBudgetPrint order={order} sheet={sheet} permitted={Boolean(sheet?.document)&&!dirty&&!busy}/></>;
}
