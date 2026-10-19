import {useDocumentUploadPreviews} from "./document-upload-previews.js";
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
import {productionWorkspaceDomainHref} from "./digital-detail-route.js";
import "./digital-budget.css";

const urls = createWebUrls(import.meta.env.BASE_URL);
const newRow = (section: BudgetRow["section"], category = ""): BudgetRow => ({ rowId: createClientRequestId(), section, category, name: "", specification: "", unit: "", supplier: "", consumption: "", unitPrice: "" });
const initial = (): BudgetDocument => ({ fabricType: "", productCategory: "", monthSeries: "", date: null, currency: "人民币", freight: "", cm: "", salePrice: "", outsourcingScope: "", outsourcingUnitPrice: "", imageAttachmentIds: [],
  rows: [...Array.from({ length: 5 }, () => newRow("主料", "面料")), ...Array.from({ length: 2 }, () => newRow("主料", "里料")),
    ...[...Array<string>(6).fill("通用物料"), ...Array<string>(3).fill("拉链"), ...Array<string>(3).fill("扣类"), ...Array<string>(3).fill("橡筋类"), ...Array<string>(3).fill("装饰牌标"), ...Array<string>(4).fill("花边/织带"), ...Array<string>(3).fill("其它")].map(category => newRow("辅料", category)),
    ...Array.from({ length: 4 }, () => newRow("外发工序"))] });

export function DigitalBudgetPanel({ order, onClose, initialVersion:requestedVersion, embedded=false,contained=false,onVersionChange }: { order: DigitalOrder; onClose: () => void; onVersionChange?:((version:number|undefined)=>void)|undefined; initialVersion?: number | undefined; contained?:boolean;embedded?:boolean }) {
  const previews=useDocumentUploadPreviews();
  const [initialVersion,setInitialVersion]=useState(requestedVersion);
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
        setSheet(value);setDoc(value.document!);setDirty(false);previews.saved();
      }
      if(publish)value=await write(`${base}/publish`,"POST",{expectedVersion:value.version});
      setSheet(value);setDoc(value.document!);setDirty(false);previews.saved();
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
    if (!files.length || writing.current) return;previews.start(files);
    writing.current = true; setBusy(true); setError("");
    try {
      const associated=new Set(doc.imageAttachmentIds);
      const limits = await digitalRequest<{ maxUploadBytes: number }>(`${base}/upload-limits`);
      for (const file of files) {try{
        if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) throw Error("请上传 JPG、PNG 或 WebP 图片");
        if (file.size > limits.maxUploadBytes) throw Error(`${file.name}超过上传大小限制`);
        const fingerprint=`${file.name}:${file.size}:${await sha256Hex(file)}`;
        const prior=completedUploads.current.get(fingerprint);if(prior&&associated.has(prior)){previews.uploaded(file,prior);continue;}
        if(associated.size>=8)throw Error("预算图片最多8张");
        const intent = await digitalRequest<UploadIntentResponse>(`${base}/upload-intents`, "POST", { filename: file.name, mimeType: file.type, sizeBytes: file.size, sha256: fingerprint.slice(fingerprint.lastIndexOf(":")+1) });
        const form = new FormData(); for (const [name, value] of Object.entries(intent.uploadFields)) form.append(name, value); form.append("file", file);
        const response = await fetch(intent.uploadUrl, { method: intent.uploadMethod, body: form, credentials: "omit" });
        if (!response.ok) throw Error(`${file.name}上传失败`);
        await digitalRequest(`${base}/attachments/${intent.attachmentId}/finalize`, "POST", {});
        previews.uploaded(file,intent.attachmentId);completedUploads.current.set(fingerprint,intent.attachmentId);associated.add(intent.attachmentId);
        setDoc(current => ({ ...current, imageAttachmentIds: [...current.imageAttachmentIds, intent.attachmentId] })); setDirty(true);
      }catch(reason){const message=reason instanceof Error?reason.message:"上传失败";previews.failed(file,message);setError(message);}}
    } catch (reason) {const message=reason instanceof Error?reason.message:"上传失败";for(const file of files)previews.failed(file,message);setError(message);}
    finally { writing.current = false; setBusy(false); }
  };
  const valid = BudgetDocumentSchema.safeParse(doc), totals = valid.success ? calculateBudget(valid.data) : null;
  const amount = (value: string | null | undefined) => value == null ? "—" : budgetDisplayAmount(value);
  const readonly=embedded||!sheet?.canEdit||sheet.status==="published", issues=validationMode?budgetIssues(doc,validationMode==="publish"):[];
  const issue=(id:string)=>issues.find(item=>item.id===id)?.message;
  const field = (key: keyof typeof budgetFieldLabels, numeric=false) => {const id=`budget-${key}`,label=budgetFieldLabels[key]!;return <label>{label}<DocumentField id={id} label={label} value={readonly&&numeric&&doc[key as keyof BudgetDocument]?budgetDisplayAmount(String(doc[key as keyof BudgetDocument])):String(doc[key as keyof BudgetDocument]??"")} onValue={value=>edit({[key]:key==="date"?(value||null):value})} readonly={readonly} disabled={busy} numeric={numeric} multiline={key==="outsourcingScope"} type={key==="date"?"date":"text"} maxLength={numeric?21:key==="outsourcingScope"?1000:100} issue={issue(id)} onBlur={numeric?()=>setValidationMode("save"):undefined}/></label>;};
  const unused=(row:BudgetRow)=>templateDefaults.current.has(row.rowId)&&row.category===templateDefaults.current.get(row.rowId)&&!activated.has(row.rowId)&&[row.name,row.specification,row.unit,row.supplier,row.consumption,row.unitPrice].every(value=>value==="");
  const addRow=(section:BudgetRow["section"])=>{const spare=doc.rows.find(row=>row.section===section&&unused(row));const row=spare??newRow(section);if(!spare)edit({rows:[...doc.rows,row]});setActivated(current=>new Set([...current,row.rowId]));requestAnimationFrame(()=>document.getElementById(`budget-${row.rowId}-category`)?.focus());};
  const removeRow=async(row:BudgetRow)=>{if(!unused(row)&&Object.keys(columns).some(key=>Boolean(row[key as keyof typeof columns]))&&!await confirmInApp("删除这条预算明细？已保存的历史版本不受影响。"))return;edit({rows:doc.rows.filter(item=>item.rowId!==row.rowId)});};
  const reload=async()=>{if(writing.current||dirty&&!await confirmInApp("重新载入将丢弃未保存修改，确定继续？"))return;setBusy(true);try{install(await digitalRequest<BudgetSheet>(`${base}${initialVersion?`?version=${initialVersion}`:""}`));setError("");}catch(reason){setError(reason instanceof Error?reason.message:"读取失败");}finally{setBusy(false);}};
  return <><Surface><section ref={root} className="budget-editor dx-doc-budget">
    <DocumentToolbar title="成本预算表" status={busy?"保存中":error&&dirty?"保存失败，修改未保存":dirty?"未保存修改":sheet?`${initialVersion?"历史已发布预算":sheet.status==="published"?"已发布预算":sheet.version?"预算草稿 · 已保存":"预算草稿"} · 预算版本 ${sheet.version} · ${readonly?"只读":"可编辑"}`:"待读取预算"}>
      {!embedded&&!contained&&<Button disabled={busy} onClick={onClose}>返回</Button>}
      {!embedded&&sheet?.canEdit&&sheet.status==="published"&&sheet.document&&initialVersion===undefined&&<Button disabled={busy} onClick={()=>void copyPublished()}>另存为新草稿</Button>}
      {!readonly&&<><Button disabled={busy} onClick={()=>void run(false)}>保存预算</Button><Button variant="primary" disabled={busy} onClick={()=>void run(true)}>发布预算</Button></>}
      <Button disabled={!sheet?.document||dirty||busy} onClick={()=>window.print()}>打印 / 保存 PDF</Button>
    </DocumentToolbar>
    <p className="budget-mobile-overview">{order.designStyleNo} · {order.customerCode} · 成本 {amount(totals?.cost)} · 利润 {amount(totals?.profit)}</p>
    {sheet&&<label>查看预算版本<select aria-label="查看预算版本" disabled={busy||embedded} value={initialVersion??''} onChange={async event=>{const version=event.target.value?Number(event.target.value):undefined;if(writing.current||dirty&&!await confirmInApp('切换版本将丢弃未保存修改，确定继续？'))return;setInitialVersion(version);const url=new URL(window.location.href);if(version)url.searchParams.set('budgetVersion',String(version));else url.searchParams.delete('budgetVersion');window.history.replaceState(window.history.state,'',url);onVersionChange?.(version);}}>{!embedded&&<option value="">当前资料</option>}{sheet.versions?.map(version=><option key={version} value={version}>已发布版本 {version}</option>)}</select></label>}
    {previews.view}<DocumentErrors issues={issues} error={error}/>
    {error&&/更新|版本|冲突/.test(error)&&<Button disabled={busy} onClick={()=>void reload()}>重新载入最新版本</Button>}
    {sheet?.canSubmitSourcing&&initialVersion===undefined&&!dirty&&<a className="dx-button dx-button--secondary budget-controls" href={productionWorkspaceDomainHref(`${urls.pageUrl("ui/sourcing/create")}?budget=${order.productionOrderId}&budgetVersion=${sheet.version}`,window.location.search)}>核实预算并进入外发申请</a>}
    {sheet?.sourcingCaseId&&<a className="dx-button dx-button--secondary budget-controls" href={productionWorkspaceDomainHref(urls.pageUrl(`ui/sourcing/orders/${sheet.sourcingCaseId}`),window.location.search)}>查看外发订单</a>}
