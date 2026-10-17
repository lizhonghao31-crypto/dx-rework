import {DocumentToolbar,DocumentErrors} from "./document-editor.js";
import { DevelopmentDocumentFields } from "./development-document-fields.js";
import { DevelopmentPatternLink, type DevelopmentPatternChoice } from "./development-pattern-link.js";
import { developmentIssues } from "./digital-development-validation.js";
import { customerOrderDateError, initialCustomerDateErrors, minimumInitialCustomerDate, digitalPoKey } from "@dx-rework/contracts/digital-production";
import { createWebUrls } from "../url-contract.js";
import "./digital-development.css";
import { SearchableSelect } from "./search-select.js";
import { useEffect, useRef, useState, useId } from "react";
import { Button, Surface } from "@dx-rework/ui";
import { DigitalOrderCreateSchema, DigitalSourceCreateSchema, type DigitalCustomer, type DigitalOrder, type DigitalOrderInput, type DigitalSource } from "@dx-rework/contracts/digital-production";
import type { OrderJourney } from "@dx-rework/contracts/digital-production-journey";
import { digitalRequest } from "./digital-production-api.js";
import { initialDigitalProductGroup } from "./digital-production-defaults.js";
import { createClientRequestId } from "./client-request-id.js";
import { registerInternalNavigationGuard } from "./internal-navigation.js";
import { confirmInApp } from "./system-dialog.js";
import { changePoDate, inheritPoDate, removePoDateOverride } from "./po-date-input-defaults.js";
import type { DevelopmentSheet, DevelopmentDocument } from "@dx-rework/contracts/digital-development";
import { developmentOrderInput, developmentQuantityError, developmentQuantityTotal, initialDevelopmentDocument, type DevelopmentOrderDraft } from "./digital-development-editing.js";
import { preparePatternMaterial } from "./pattern-material-upload.js";
import { uploadDevelopmentMaterial } from "./digital-development-upload.js";
import { verifySession } from "./auth.js";

const customerPoDateLabel="出货日期";

type CreatePicture = {id: string; file: File; preview: string; kind: DevelopmentDocument["files"][number]["kind"]; attachmentId?: string; error?: string | undefined};

export type DevelopmentCreateIntent = "development" | "certain_order" | "confirm_order";
const newLine = (): DevelopmentOrderDraft["lines"][number] => ({formalPoNo:null, customerWarehouseArrivalDate:null, poNumber: null, formalStyleNo: null, temporaryStyleNo: null, color: "", colorForeign: null, deliveryDate: null, sizes: [{size: "", quantity: ""}]});
export function initialDevelopmentOrder(customers: DigitalCustomer[], source?: OrderJourney): DevelopmentOrderDraft {
  return {customerCode: source?.customer ?? "", designStyleNo: source?.designStyleNo ?? "", temporaryStyleNo: source?.temporaryStyleNo ?? null,
    productGroup: initialDigitalProductGroup(customers, source?.customer ?? undefined),
    primaryMerchandiserId: customers.find(customer => customer.code === source?.customer)?.defaultMerchandiserId ?? null,
    orderDate: new Intl.DateTimeFormat("en-CA", {timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit"}).format(new Date()), contractDeliveryDate: null, lines: [newLine()]};
}

/** A facade over the existing source and order commands; no sample approval or route writes. */
export function DevelopmentCreateForm({intent, source, customers, onCancel, onCreated, onIntentChange, existingDraft, minimumDate, serverToday, contained=false}: {
  contained?:boolean; intent: DevelopmentCreateIntent; source?: OrderJourney; existingDraft?: DevelopmentSheet; minimumDate?:string|undefined; serverToday?:string|undefined; customers: DigitalCustomer[];
  onCancel: () => void; onCreated: (sourceId: string, orderId: string | null) => void;
  onIntentChange?: (intent: "development" | "certain_order") => void;
}) {
  const formId=useId();
  const [form, setForm] = useState(() => existingDraft?.document?.customerOrderDraft?.order ?? {...initialDevelopmentOrder(customers, source),...(serverToday?{orderDate:serverToday}:{}),...(existingDraft?{customerCode:existingDraft.customerCode??"",designStyleNo:existingDraft.designStyleNo,temporaryStyleNo:existingDraft.temporaryStyleNo}:{} )});
  const [document,setDocument]=useState<DevelopmentDocument>(()=>existingDraft?.document??{...initialDevelopmentDocument(),orderDate:form.orderDate});
  const [quantityInput,setQuantityInput]=useState(()=>document.quantity===null?"":String(document.quantity));
  const [validationMode,setValidationMode]=useState<"save"|"publish"|null>(null);
  const [patternChoice,setPatternChoice]=useState<DevelopmentPatternChoice|null>(null);
  const [published,setPublished]=useState(existingDraft?.status==="published");
  const [boundOrder,setBoundOrder]=useState(existingDraft?.status==="published"&&existingDraft.document?.customerOrderDraft?.withOrder?existingDraft.document.customerOrderDraft.order:null);
  const loadedVersion=useRef<number|null>(existingDraft?.version??null);
  const [fileKind,setFileKind]=useState<DevelopmentDocument["files"][number]["kind"]>("款图");
  const measurementIds=useRef(document.measurements.map(()=>createClientRequestId()));
  const successfulUploads=useRef(new Map<string,string>()),publishKey=useRef<{payload:string;key:string}|null>(null);
  const edit=(patch:Partial<DevelopmentDocument>)=>setDocument(current=>({...current,...patch}));
  const issues=validationMode?developmentIssues(document,quantityInput,measurementIds.current,validationMode==="publish"):[];
  const dateMinimum=minimumDate??minimumInitialCustomerDate();
  const [designerName, setDesignerName] = useState<string | null>(existingDraft?.designerName ?? source?.designer ?? null);
  useEffect(() => {
    if (source || existingDraft) return;
    let live = true;
    void verifySession().then(session => {if (live && session !== "denied" && session.status === "authorized") setDesignerName(session.user.displayName);});
    return () => {live = false;};
  }, [source,existingDraft]);
  const [pictures, setPictures] = useState<CreatePicture[]>([]);
  const picturesRef = useRef<CreatePicture[]>([]), previews = useRef<string[]>([]);
  const draftSaveKey = useRef<{payload: string; key: string} | null>(null);
  useEffect(() => () => {for (const url of previews.current) URL.revokeObjectURL(url);}, []);
  const customerDateOverrides = useRef(new Set<number>(form.lines.flatMap((line,index)=>index>0&&line.customerWarehouseArrivalDate!==form.lines[0]?.customerWarehouseArrivalDate?[index]:[])));
  const [developmentType, setDevelopmentType] = useState<"头版" | "开发板">(existingDraft?.developmentType==="开发板"?"开发板":"头版");
  const [createdSource, setCreatedSource] = useState<string | null>(existingDraft?.sourceId ?? source?.sourceId ?? null);
  const [fixedCustomer, setFixedCustomer] = useState<string | null>(existingDraft?.customerCode ?? source?.customer ?? null);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [errorField,setErrorField]=useState<string|null>(null);
  const [duplicateSource,setDuplicateSource]=useState<string|null>(null),sourceSearchSequence=useRef(0);
  const findExistingSource=async(value:string)=>{
    const sequence=++sourceSearchSequence.current;setDuplicateSource(null);
    if(createdSource||!value.trim())return;
    try{const result=await digitalRequest<{items:DigitalSource[]}>(`sources?search=${encodeURIComponent(value.trim())}`);
      if(sequence!==sourceSearchSequence.current)return;
      const existing=result.items.find(item=>digitalPoKey(item.designStyleNo)===digitalPoKey(value));
      if(existing){setDuplicateSource(existing.sourceId);setError("该编号已有开发档案，请打开原档案继续办理");}
    }catch{ /* Submission still enforces the authoritative duplicate check. */ }
  };
  const [savedDraft, setSavedDraft] = useState<string | null>(null);
  const writing = useRef(false), sourceKey = useRef<{payload: string; key: string} | null>(null), orderKey = useRef<{payload: string; key: string} | null>(null);
  const draftSnapshot = (items: CreatePicture[], value=document) => JSON.stringify({intent, form, developmentType, document:value, pictures: items.map(item => [item.id, item.attachmentId ?? null])});
  const currentSnapshot = draftSnapshot(pictures);
  const initial = useRef(currentSnapshot), dirty = useRef(false), completed = useRef(false);
  dirty.current = currentSnapshot !== initial.current;
  useEffect(() => {
    const unregister = registerInternalNavigationGuard(async () => {
      if (writing.current) return false;
      if (completed.current || !dirty.current) return true;
      return await confirmInApp("有未保存开发资料或订购信息，确定离开？") && !writing.current;
    });
    const unload = (event: BeforeUnloadEvent) => {if (writing.current || (!completed.current && dirty.current)) {event.preventDefault(); event.returnValue = "";}};
    window.addEventListener("beforeunload", unload);
    return () => {unregister(); window.removeEventListener("beforeunload", unload);};
  }, []);
  const withOrder = intent !== "development";
  const title = intent === "confirm_order" ? "客户确定订单 · 补订购信息" : withOrder ? "产品开发（有确定订单）" : "产品开发（无确定订单）";
  const line = (index: number, patch: Partial<DevelopmentOrderDraft["lines"][number]>) => setForm(current => ({...current, lines: current.lines.map((value, i) => i === index ? {...value, ...patch} : value)}));
  const selectPictures = async (files: File[]) => {
    if (writing.current || !files.length) return;
    writing.current = true; setBusy(true); setError("");
    try {
      let fileCount=document.files.length;
      for (const original of files) {
        if (fileCount >= 30) throw new Error("开发单最多30个附件，请先移除不用的文件");
        const file = original.type === "application/pdf" ? original : await preparePatternMaterial(original);
        if (["款图","局部图"].includes(fileKind) && !file.type.startsWith("image/")) throw new Error("款图和局部图请使用 JPG、PNG 或 WebP");
        const preview = URL.createObjectURL(file); previews.current.push(preview);
        fileCount++; const id=createClientRequestId();
        picturesRef.current = [...picturesRef.current, {id, file, preview,kind:fileKind}];
        setDocument(current=>({...current,files:[...current.files,{attachmentId:id,kind:fileKind}]}));
        setPictures(picturesRef.current);
      }
    } catch (reason) {setError(reason instanceof Error ? reason.message : "图片无法读取，请换一张或重试；其它资料仍保留");}
    finally {writing.current = false; setBusy(false);}
  };
  const customerDate = (index: number, date: string | null) => {
    const overrides = new Set(customerDateOverrides.current);
    if (index > 0) overrides.add(index);
    customerDateOverrides.current = overrides;
    setForm(current => ({...current, lines: changePoDate(current.lines, "customerWarehouseArrivalDate", index, date, overrides)}));
  };
  const removeLine = (index: number) => {
    customerDateOverrides.current = removePoDateOverride(customerDateOverrides.current, index);
    setForm(current => ({...current, lines: current.lines.length > 1 ? current.lines.filter((_, position) => position !== index) : current.lines}));
  };
  const save = async (draftOnly = false) => {
    if (writing.current) return;
    writing.current = true; setBusy(true); setError("");setErrorField(null);
    try {
      if(!form.designStyleNo.trim())throw new Error("请填写设计款号");
      if(withOrder&&!draftOnly&&!form.customerCode)throw new Error("请选择客户");
      const sourceInput = DigitalSourceCreateSchema.parse({developmentType, designStyleNo: form.designStyleNo, temporaryStyleNo: form.temporaryStyleNo, customerCode: form.customerCode || null});
      const orderInput = withOrder && !draftOnly ? DigitalOrderCreateSchema.parse(developmentOrderInput(form)) : null;
      if(orderInput){
        const calendar=await digitalRequest<{serverToday:string;minimumInitialCustomerDate:string}>("options");
        if(!calendar.serverToday||!calendar.minimumInitialCustomerDate)throw new Error("未取得服务器日期，请重试；输入仍保留");
        const dateError=customerOrderDateError(orderInput.orderDate,calendar.serverToday);
        if(dateError)throw new Error(dateError);
        const errors=initialCustomerDateErrors(orderInput.lines,calendar.minimumInitialCustomerDate);if(errors.length)throw new Error(errors.join("；"));
      }
      if(!source&&!published){setValidationMode(draftOnly?"save":"publish");if(developmentIssues(document,quantityInput,measurementIds.current,!draftOnly).length)return;if(!draftOnly&&!patternChoice)throw new Error("请先选择有效打板品类与执行价，再发布开发单");}
      let id = createdSource;
      if (!id) {
        const payload = JSON.stringify(sourceInput);
        if (sourceKey.current?.payload !== payload) sourceKey.current = {payload, key: createClientRequestId()};
        const next = await digitalRequest<Pick<DigitalSource,"sourceId">>("sources", "POST", sourceInput, sourceKey.current.key);
        id = next.sourceId; setCreatedSource(id); setFixedCustomer(sourceInput.customerCode);
      }
      let persistedDocument=document;
      if (!source) {
        const base = `sources/${id}/development`;
        let sheet = await digitalRequest<DevelopmentSheet>(base);
        if(loadedVersion.current===null)loadedVersion.current=sheet.version;
        if (sheet.status !== "published") {
          if (!sheet.canEdit) throw new Error("当前没有修改开发单的权限");
          const desired=new Set(document.files.map(file=>file.attachmentId));
          const pending=picturesRef.current.filter(picture=>desired.has(picture.id)||Boolean(picture.attachmentId&&desired.has(picture.attachmentId)));
          if(pending.some(picture=>!picture.attachmentId)){
            const limits=await digitalRequest<{maxUploadBytes:number}>(`${base}/upload-limits`);
            for(const picture of pending){
              if(picture.attachmentId)continue;
              try{const attachmentId=await uploadDevelopmentMaterial(base,picture.file,picture.kind,limits.maxUploadBytes);
                picturesRef.current=picturesRef.current.map(item=>item.id===picture.id?{...item,attachmentId,error:undefined}:item);setPictures(picturesRef.current);
              }catch(reason){const message=reason instanceof Error?reason.message:"上传失败，请重试";picturesRef.current=picturesRef.current.map(item=>item.id===picture.id?{...item,error:message}:item);setPictures(picturesRef.current);throw reason;}
            }
          }
          persistedDocument={...document,customerOrderDraft:{withOrder,order:form},files:document.files.map(file=>({ ...file,attachmentId:picturesRef.current.find(picture=>picture.id===file.attachmentId)?.attachmentId??file.attachmentId }))};
          setDocument(persistedDocument);
          if(loadedVersion.current!==null&&sheet.version!==loadedVersion.current&&JSON.stringify(sheet.document)!==JSON.stringify(persistedDocument))throw new Error("开发单已更新，请重新打开后再保存；当前填写仍保留");
          if(JSON.stringify(sheet.document)!==JSON.stringify(persistedDocument)){
            const body={expectedVersion:sheet.version,document:persistedDocument},payload=JSON.stringify(body);
            if(draftSaveKey.current?.payload!==payload)draftSaveKey.current={payload,key:createClientRequestId()};
            sheet=await digitalRequest<DevelopmentSheet>(base,"PUT",body,draftSaveKey.current.key);
          }
          loadedVersion.current=sheet.version;
          if(!draftOnly){
            const body={expectedVersion:sheet.version,patternOrder:patternChoice},payload=JSON.stringify(body);
            if(publishKey.current?.payload!==payload)publishKey.current={payload,key:createClientRequestId()};
            const publishedSheet=await digitalRequest<DevelopmentSheet>(`${base}/publish`,"POST",body,publishKey.current.key);setPublished(true);
            if(publishedSheet.document?.customerOrderDraft?.withOrder){setBoundOrder(publishedSheet.document.customerOrderDraft.order);setForm(publishedSheet.document.customerOrderDraft.order);}
          }
        } else {setPublished(true);if(sheet.document?.customerOrderDraft?.withOrder){setBoundOrder(sheet.document.customerOrderDraft.order);setForm(sheet.document.customerOrderDraft.order);}if(draftOnly)throw new Error("开发单已发布，请继续确认客户订单或重新打开查看");persistedDocument=sheet.document??document;}
      }
      let orderId: string | null = null;
      if (orderInput) {
        const payload = JSON.stringify(orderInput);
        if (orderKey.current?.payload !== payload) orderKey.current = {payload, key: createClientRequestId()};
        const order = await digitalRequest<DigitalOrder>(`sources/${id}/confirm`, "POST", orderInput, orderKey.current.key);
        orderId = order.productionOrderId;
      }
      if (draftOnly) {
        const snapshot = draftSnapshot(picturesRef.current,persistedDocument);
        initial.current = snapshot; dirty.current = false;
        setSavedDraft(snapshot);
        return;
      }
      completed.current = true; writing.current = false; onCreated(id, orderId);
    } catch (reason) {
      const validation = reason as {issues?: Array<{message:string;path:Array<string|number>}>};
      const issue=validation.issues?.[0];
      const field=issue?.path.at(-1),labels:Record<string,string>={designStyleNo:"设计款号",customerCode:"客户",productGroup:"产品分组",orderDate:"下单日期",color:"颜色",size:"尺码",quantity:"订购数量",lines:"PO 明细"};
      const prefix=issue?.path[0]==="lines"&&typeof issue.path[1]==="number"?`PO ${issue.path[1]+1} `:"";
      setError(issue?( /[\u3400-\u9fff]/.test(issue.message)?issue.message:`${prefix}${labels[String(field)]??"订购资料"}填写有误，请核实必填内容与允许范围`):(reason instanceof Error?reason.message:"保存失败"));
      const message=reason instanceof Error?reason.message:"";
      const po=message.match(/PO (\d+)/)?.[1],index=typeof issue?.path[1]==='number'?issue.path[1]+1:null;
      const target=message.includes('客户下单日期')?'development-customer-order-date':field==='designStyleNo'||message.includes('设计款号')?'development-create-style':field==='customerCode'||message.includes('请选择客户')?'development-create-customer':po?`development-po-date-${po}`:index&&field==='color'?`development-po-color-${index}`:null;
      setErrorField(target);if(target)requestAnimationFrame(()=>window.document.getElementById(target)?.focus());
    } finally {writing.current = false; setBusy(false);}
  };
  const rowTotals = form.lines.map(row => developmentQuantityTotal(row.sizes));
  const totalQuantity = rowTotals.some(total => total === null) ? null : rowTotals.reduce<number>((sum, total) => sum + (total ?? 0), 0);
  const returnToList = async () => {
    if ((!dirty.current || await confirmInApp("有未保存开发资料或订购信息，确定离开？")) && !writing.current) onCancel();
  };
  return <Surface className="development-create development-create-reference"><form id={formId} noValidate onKeyDown={event=>{if(event.key==="Enter"&&event.nativeEvent.isComposing)event.preventDefault();}} onSubmit={event => {event.preventDefault(); void save();}}>
    {contained?<DocumentToolbar title={title} status={busy?"保存中":published?"已发布，待确认订单":"开发草稿"}>{!source && !published && <Button type="button" disabled={busy} onClick={() => void save(true)}>保存开发资料草稿</Button>}<Button form={formId} type="submit" variant="primary" disabled={busy}>{busy ? "保存中…" : intent === "confirm_order" ? "确认下单" : published ? "确认客户订单" : withOrder ? "发布开发单并确认订单" : "发布开发单"}</Button></DocumentToolbar>:<header className="development-create-heading"><div><div className="development-create-title"><h2>{intent === "confirm_order" ? title : "新建开发订单"}</h2><Button type="button" disabled={busy} onClick={() => void returnToList()}>返回列表</Button></div><p>{title}</p></div><div className="pattern-actions">{!source && !published && <Button type="button" disabled={busy} onClick={() => void save(true)}>保存开发资料草稿</Button>}<Button form={formId} type="submit" variant="primary" disabled={busy}>{busy ? "保存中…" : intent === "confirm_order" ? "确认下单" : published ? "确认客户订单" : withOrder ? "发布开发单并确认订单" : "发布开发单"}</Button></div></header>}
    {!source&&<div className="development-order-intent" role="group" aria-label="确定客户订单">{([['development','无确定客户订单'],['certain_order','有确定客户订单']] as const).map(([value,label])=><Button key={value} type="button" aria-pressed={intent===value} disabled={busy||published||!onIntentChange} onClick={()=>onIntentChange?.(value)}>{label}</Button>)}</div>}
    {source && <p>沿用第 {source.adoptedRound ?? source.selectedRound ?? 1} 轮开发资料；头版/开发板与已有工序保持原档案。</p>}
    {error && <DocumentErrors error={error} issues={errorField?[{id:errorField,label:"定位需核实字段",message:error}]:[]}/>}
    {duplicateSource&&<a href={createWebUrls(import.meta.env.BASE_URL).pageUrl(`ui/digital-production?development=${duplicateSource}`)}>打开已有开发档案</a>}
    {savedDraft === currentSnapshot && <p role="status">开发资料与订购草稿已保存，重开可继续；尚未发布或创建客户订单。</p>}
    {createdSource && !source && error && <p role="status">开发档案已保存。修正订购信息后重试会沿用此档案。</p>}
    {boundOrder&&<p role="status">订购草稿已随开发资料发布；确认与重试沿用已发布的 PO、数量和日期。</p>}
    <fieldset disabled={busy}><fieldset disabled={Boolean(boundOrder)} className="development-order-fields"><div className="development-create-layout development-create-layout-existing">
    <div className="development-create-order"><section className="development-create-card"><h3>基本资料</h3><div className="development-create-grid">
      {intent !== "confirm_order" && <label>开发类型<select aria-label="开发类型" disabled={Boolean(createdSource)} value={developmentType} onChange={event => setDevelopmentType(event.target.value as "头版" | "开发板")}><option>头版</option><option>开发板</option></select></label>}
      <label>设计款号（必填）<input id="development-create-style" aria-label="设计款号" required maxLength={100} value={form.designStyleNo} readOnly={Boolean(createdSource)} onBlur={event=>void findExistingSource(event.target.value)} onChange={event => {sourceSearchSequence.current++;setDuplicateSource(null);setForm({...form, designStyleNo: event.target.value});}}/></label>
      <label>设计师（只读）<input aria-label="设计师（只读）" readOnly value={designerName ?? "正在确认身份…"}/></label>
      <label>代用款号（选填）<input maxLength={100} value={form.temporaryStyleNo ?? ""} readOnly={Boolean(createdSource)} onChange={event => setForm({...form, temporaryStyleNo: event.target.value || null})}/></label>
      <label>客户{withOrder ? "（必填）" : "（选填）"}<SearchableSelect id="development-create-customer" aria-label="客户" required={withOrder} disabled={Boolean(createdSource && (fixedCustomer || !withOrder))} value={form.customerCode} onChange={event => {const customer = customers.find(customer => customer.code === event.target.value); setForm({...form, customerCode: event.target.value, primaryMerchandiserId: customer?.defaultMerchandiserId ?? null, productGroup: initialDigitalProductGroup(customers, event.target.value)});}}><option value="">通用开发 / 请选择</option>{customers.map(customer => <option key={customer.code} value={customer.code}>{customer.code} · {customer.name}</option>)}</SearchableSelect></label>
</div>{withOrder && <>      <div className="development-create-grid"><label>产品分组<select aria-label="产品分组" value={form.productGroup} onChange={event => setForm({...form, productGroup: event.target.value as DigitalOrderInput["productGroup"]})}>{(customers.find(customer => customer.code === form.customerCode)?.productGroups ?? [form.productGroup]).map(group => <option key={group}>{group}</option>)}</select></label>
        <label>客户下单日期（必填）<input id="development-customer-order-date" aria-label="客户下单日期" required max={serverToday} type="date" value={form.orderDate} onChange={event => setForm({...form, orderDate: event.target.value})}/></label>
</div>
</>}</section>
    {withOrder && <section className="development-create-card development-create-details"><h3>客户订单明细</h3><p>颜色、尺码、订购数量及客户交期在正式提交客户订单时必填；保存开发草稿后可继续补齐。</p><p>客户侧交期默认沿用首个 PO，可分别修改；首次确认须为 {dateMinimum} 或之后。</p><p>默认主跟单：{customers.find(customer => customer.code === form.customerCode)?.defaultMerchandiserName ?? "未配置，待主管指派"}</p>
      <div className="development-table-scroll" role="region" aria-label="PO 明细，可左右滑动查看全部列" tabIndex={0}>
        <table className="development-create-po-table"><thead><tr>
          <th className="development-po-index">PO</th><th className="development-po-number">正式款号 / PO</th><th className="development-po-color">颜色 *</th>
          {form.lines[0]?.sizes.map((size, sizeIndex) => <th className="development-size-column" key={sizeIndex}>
            <span className="development-size-label">尺码 *</span>
            <input aria-label={`尺码列 ${sizeIndex + 1}`} placeholder="如 S / M / 36" required maxLength={100} value={size.size} onChange={event => setForm(current => ({...current, lines: current.lines.map(row => ({...row, sizes: row.sizes.map((item, i) => i === sizeIndex ? {...item, size: event.target.value} : item)}))}))}/>
            {form.lines[0]!.sizes.length > 1 && <button type="button" aria-label={`删除尺码列 ${sizeIndex + 1}`} onClick={async () => {if (await confirmInApp("删除这个尺码列及所有 PO 对应订购数量？") && !writing.current) setForm(current => ({...current, lines: current.lines.map(row => ({...row, sizes: row.sizes.filter((_, i) => i !== sizeIndex)}))}));}}>×</button>}
          </th>)}
          <th className="development-row-total">合计（件）</th><th className="development-po-date">{customerPoDateLabel}</th>{form.lines.length > 1 && <th className="development-po-actions">删除 PO</th>}
        </tr></thead><tbody>{form.lines.map((value, index) => <tr key={index}>
          <th className="development-po-index">{index + 1}</th>
          <td className="development-po-number"><input aria-label={`PO ${index + 1} 正式款号 / PO`} placeholder="选填，可后补" maxLength={100} value={value.formalPoNo ?? ""} onChange={event => line(index, {formalPoNo: event.target.value || null})}/></td>
          <td className="development-po-color"><input id={`development-po-color-${index+1}`} aria-label={`PO ${index + 1} 颜色`} placeholder="颜色（必填）" required maxLength={100} value={value.color} onChange={event => line(index, {color: event.target.value})}/><input aria-label={`PO ${index + 1} 颜色外文`} placeholder="颜色外文（选填）" maxLength={100} value={value.colorForeign ?? ""} onChange={event => line(index, {colorForeign: event.target.value || null})}/></td>
          {value.sizes.map((size, sizeIndex) => {
            const quantityError = developmentQuantityError(size.quantity), errorId = `development-quantity-error-${index}-${sizeIndex}`;
            return <td className="development-size-column" key={sizeIndex}><label className="development-quantity-field"><span>数量（件）*</span>
              <input aria-label={`PO ${index + 1} 订购数量 ${sizeIndex + 1}`} type="text" inputMode="numeric" maxLength={8} placeholder="件数" value={size.quantity} aria-invalid={quantityError !== null} aria-describedby={quantityError ? errorId : undefined} onChange={event => line(index, {sizes: value.sizes.map((item, i) => i === sizeIndex ? {...item, quantity: event.target.value} : item)})}/>
              {quantityError && <small className="development-quantity-error" id={errorId} role="alert">{quantityError}</small>}
            </label></td>;
          })}
          <td className="development-row-total">{rowTotals[index] === null ? <span className="development-quantity-error">请修正数量</span> : rowTotals[index]?.toLocaleString()}</td>
          <td className="development-po-date"><input id={`development-po-date-${index+1}`} aria-label={`PO ${index + 1} ${customerPoDateLabel}`} type="date" min={dateMinimum} value={value.customerWarehouseArrivalDate ?? ""} onChange={event => customerDate(index, event.target.value || null)}/></td>
          {form.lines.length > 1 && <td className="development-po-actions"><Button type="button" onClick={async () => {if (await confirmInApp("删除这个 PO 和全部订购数量？") && !writing.current) removeLine(index);}}>删除 PO</Button></td>}
        </tr>)}</tbody></table>
      </div>
      <div className="development-create-line-actions"><Button type="button" disabled={form.lines.length >= 50} onClick={() => setForm(current => ({...current, lines: [...current.lines, inheritPoDate({...newLine(), sizes: current.lines[0]!.sizes.map(size => ({size:size.size, quantity:""}))}, current.lines[0], "customerWarehouseArrivalDate")]}))}>添加款色 / PO</Button>
        <Button type="button" disabled={form.lines[0]!.sizes.length >= 50} onClick={() => setForm(current => ({...current, lines: current.lines.map(row => ({...row, sizes: [...row.sizes, {size:"", quantity:""}]}))}))}>添加尺码列</Button>
        <strong className="development-total-quantity" role="status">总订购数量：{totalQuantity === null ? <span className="development-quantity-error">请修正数量</span> : `${totalQuantity.toLocaleString()} 件`}</strong>
      </div></section>}
    </div></div></fieldset>
    {!source&&<div className="development-editor dx-doc-development">
      <DocumentErrors issues={issues}/>
      {pictures.filter(picture=>picture.error).map(picture=><p key={picture.id} role="alert">{picture.file.name}：{picture.error}</p>)}
      <DevelopmentDocumentFields uploadHelp="选择后可预览，保存草稿或发布时上传；失败资料仍保留。" document={document} edit={edit} readonly={published} busy={busy} writing={writing} quantityInput={quantityInput} setQuantityInput={setQuantityInput} measurementIds={measurementIds} successfulUploads={successfulUploads} imageUrl={id=>picturesRef.current.find(picture=>picture.id===id||picture.attachmentId===id)?.preview??createWebUrls(import.meta.env.BASE_URL).apiUrl(`digital-production/sources/${createdSource}/development/attachments/${id}`)} upload={selectPictures} fileKind={fileKind} setFileKind={setFileKind} issue={id=>issues.find(value=>value.id===id)?.message} patternSection={!published?<div id="development-pattern-preparation"><DevelopmentPatternLink busy={busy} preparing selectedCategoryId={document.patternCategoryId??""} onCategoryChange={categoryId=>edit({patternCategoryId:categoryId||null})} onSelection={setPatternChoice}/></div>:null}/>
    </div>}
    </fieldset>
  </form></Surface>;
}

export function ResumeDevelopmentCreateForm({sheet,onClose,onCreated,onViewPublished,contained=false}:{contained?:boolean;sheet:DevelopmentSheet;onClose:()=>void;onCreated:()=>void;onViewPublished?:()=>void}) {
  const [options,setOptions]=useState<{customers:DigitalCustomer[];minimumInitialCustomerDate?:string;serverToday?:string}|null>(null);
  const [error,setError]=useState("");
  const [intent,setIntent]=useState<"development"|"certain_order">(sheet.document?.customerOrderDraft?.withOrder?"certain_order":"development");
  useEffect(()=>{let live=true;void digitalRequest<{customers:DigitalCustomer[];minimumInitialCustomerDate?:string;serverToday?:string}>("options").then(value=>{if(live)setOptions(value);}).catch(reason=>{if(live)setError(reason instanceof Error?reason.message:"读取客户资料失败");});return()=>{live=false;};},[]);
  return error?<p role="alert">{error}</p>:!options?<p role="status">正在读取开发草稿…</p>:<>{sheet.status==="published"&&onViewPublished&&<Button type="button" onClick={onViewPublished}>查看已发布资料、版本与办理</Button>}<DevelopmentCreateForm contained={contained} existingDraft={sheet} intent={intent} customers={options.customers} minimumDate={options.minimumInitialCustomerDate} serverToday={options.serverToday} onIntentChange={setIntent} onCancel={onClose} onCreated={onCreated}/></>;
}
