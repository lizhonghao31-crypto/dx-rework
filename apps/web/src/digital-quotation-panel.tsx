import {quotationHistoryFromSearch} from './quotation-history-route.js';
import {useEffect,useRef,useState} from 'react';
import {Button,Surface} from '@dx-rework/ui';
import {BudgetDocumentSchema,BUDGET_SECTIONS,calculateBudget,budgetDisplayAmount,type BudgetDocument,type BudgetRow} from '@dx-rework/contracts/digital-budget';
import {QuotationResourceSchema,SaveQuotationSchema,QuotationConfirmationSchema,type QuotationAssignment,type QuotationResource,type QuotationSheet} from '@dx-rework/contracts/digital-quotation';
import {DocumentField,DocumentSection,DocumentTableScroll,DocumentToolbar} from './document-editor.js';
import {digitalRequest,DigitalRequestError} from './digital-production-api.js';
import {createClientRequestId} from './client-request-id.js';
import {createWebUrls} from '../url-contract.js';
import {confirmInApp} from './system-dialog.js';
import {useDigitalDetailNavigationGuard} from './use-digital-detail-navigation-guard.js';
import {SUBMISSION_RECOVERY_WINDOW_MS} from './submission-attempt.js';
import {unknownWriteResult} from './request-response-feedback.js';
import {digitalDetailReturnUrl} from './digital-detail-route.js';
import {useForegroundWait} from './foreground-loading.js';
import {useForegroundRead} from './use-foreground-read.js';
import './digital-budget.css';
import './digital-quotation.css';
const urls=createWebUrls(import.meta.env.BASE_URL);
const empty=():BudgetDocument=>({fabricType:'',productCategory:'',monthSeries:'',date:null,currency:'人民币',rows:[],freight:'',cm:'',salePrice:'',outsourcingScope:'',outsourcingUnitPrice:'',imageAttachmentIds:[]});
const route=(resource:QuotationResource)=>`${resource.kind==='order'?'orders':'sources'}/${resource.id}/quotation`;
export function quotationHref(resource:QuotationResource,returnTo?:string){return urls.pageUrl(`ui/digital-quotation?kind=${resource.kind}&id=${resource.id}${returnTo?`&returnTo=${encodeURIComponent(returnTo)}`:''}`);}
export async function quotationRequest(path:string,resource:QuotationResource,method='GET',body?:unknown,key?:string){
 const value=await digitalRequest<QuotationSheet>(path,method,body,key);
 if(!value||value.resource?.id!==resource.id||value.resource.kind!==resource.kind||!Number.isSafeInteger(value.version)||value.version<0||!Array.isArray(value.rows)||typeof value.fullCost!=='boolean'||typeof value.canStructure!=='boolean'||typeof value.canConfirm!=='boolean'||!Array.isArray(value.assignments)||!['draft','confirmed'].includes(value.status)||(value.document!==null&&!BudgetDocumentSchema.safeParse(value.document).success))throw new DigitalRequestError('未收到可确认的报价回执，请保留输入并核对原请求',200,'INVALID_RESPONSE');
 if(method!=='GET'){
  const expected=(body as {expectedVersion?:number}|undefined)?.expectedVersion,applied=value.commandReceipt?.appliedVersion;
  const action=path.endsWith('/confirm')?'confirm':path.includes('/rows/')?`row:${path.split('/').at(-1)}`:'save';
  if(!Number.isSafeInteger(expected)||applied===undefined||value.commandReceipt?.action!==action||applied!==(path.endsWith('/confirm')?expected:expected!+1)||value.version<applied)throw new DigitalRequestError('报价操作回执版本不完整，原输入和请求标识保留',200,'INVALID_RESPONSE');
 }
 return value;
}
type QuotationListItem={resource:QuotationResource;designStyleNo:string;version:number;status:string};
const readQuotationList=(signal:AbortSignal)=>digitalRequest<{items:QuotationListItem[]}>('quotations','GET',undefined,undefined,{signal});

export function DigitalQuotationPage(){
 const query=new URLSearchParams(window.location.search),parsed=QuotationResourceSchema.safeParse({kind:query.get('kind'),id:query.get('id')});
 const listView=!query.has('id')&&!query.has('kind');
 const list=useForegroundRead('quotations',listView?'assigned':null,readQuotationList,true);
 useForegroundWait(list.foregroundKey);
 const items=Array.isArray(list.value?.items)?list.value.items:[];
 const error=list.error?.message;
 if(query.has('id')||query.has('kind'))return parsed.success?<DigitalQuotationPanel key={`${parsed.data.kind}:${parsed.data.id}`} resource={parsed.data}/>:<Surface><p role="alert">报价来源编号无效，请从原单进入</p></Surface>;
 return <Surface><h1>报价协作</h1><p>显示最近100条当前有权的报价；更早报价可从原单进入。用量与价格由各自负责岗位填写。</p>{error&&<><p role="alert">{error}</p><Button onClick={list.retry}>重试读取</Button></>}<DocumentTableScroll><table><thead><tr><th>设计编号</th><th>版本</th><th>状态</th><th>办理</th></tr></thead><tbody>{items.map(item=><tr key={item.resource.id}><td>{item.designStyleNo}</td><td>{item.version}</td><td>{item.status==='confirmed'?'客户已确认':'协作草稿'}</td><td><a href={quotationHref(item.resource)}>打开报价</a></td></tr>)}</tbody></table></DocumentTableScroll>{!items.length&&!error&&!list.waiting&&<p>暂无分配给自己的报价；设计可从原开发单或预算页建立。</p>}</Surface>;
}
export function DigitalQuotationPanel({resource}:{resource:QuotationResource}){
 const [initialHistory]=useState(()=>quotationHistoryFromSearch(window.location.search,resource));
 const [sheet,setSheet]=useState<QuotationSheet|null>(null),[document,setDocument]=useState<BudgetDocument>(empty),[assignments,setAssignments]=useState<QuotationAssignment[]>([]);
 const [participants,setParticipants]=useState<Array<{id:string;name:string;role:string}>>([]),[rowInputs,setRowInputs]=useState<Record<string,{consumption?:string;unitPrice?:string;pricingUnit?:string}>>({});
 const [adoptions,setAdoptions]=useState<Record<string,string>>({});
 const [structureDirty,setStructureDirty]=useState(false),[editingRowId,setEditingRowId]=useState<string|null>(null),[confirmationDirty,setConfirmationDirty]=useState(false);
 const [error,setError]=useState(''),[busy,setBusy]=useState(false),[dirty,setDirty]=useState(false),[uncertain,setUncertain]=useState(false),[history,setHistory]=useState<number|undefined>(initialHistory.version),[retry,setRetry]=useState(0);
 const [confirmedTotal,setConfirmedTotal]=useState(''),[scope,setScope]=useState<'per_piece'|'order_total'>('per_piece'),[quantity,setQuantity]=useState(''),[taxBasis,setTaxBasis]=useState<'excludes_tax'|'includes_tax'>('excludes_tax'),[evidence,setEvidence]=useState(''),[confirmedDate,setConfirmedDate]=useState('');
 const writing=useRef(false),generation=useRef(0),operation=useRef<{path:string;method:string;body:unknown;key:string;startedAt:number}|null>(null),base=route(resource);
 const readKey=JSON.stringify([base,history,retry]);
 const [displayedRead,setDisplayedRead]=useState<string|null>(null);
 const [settledRead,setSettledRead]=useState<string|null>(null);
 const refreshing=!initialHistory.error&&settledRead!==readKey;
 const canEditDisplayed=displayedRead===readKey&&!refreshing;
 useForegroundWait(refreshing?readKey:undefined);
 const install=(value:QuotationSheet)=>{setSheet(value);setDocument(value.document??empty());setAssignments(value.assignments);setRowInputs({});setDirty(false);setStructureDirty(false);setEditingRowId(null);setConfirmationDirty(false);};
 useDigitalDetailNavigationGuard(dirty||confirmationDirty||uncertain,busy,writing,'报价有未保存或结果未确认的修改，离开不会撤销已发送的请求。确定离开？');
 useEffect(()=>{
  if(initialHistory.error){setError(initialHistory.error);return;}
  let live=true;
  const epoch=++generation.current;
  setError('');
  void quotationRequest(`${base}${history?`?version=${history}`:''}`,resource).then(async value=>{
   if(!live||epoch!==generation.current)return;
   install(value);
   setDisplayedRead(readKey);
   operation.current=null;
   if(!value.canStructure){setParticipants([]);return;}
   try{
    const people=await digitalRequest<{items:typeof participants}>(`${base}/participants`);
    if(live&&epoch===generation.current)setParticipants(people.items);
   }catch(error){
    if(live)setError(error instanceof Error?error.message:'负责人列表读取失败，请重试');
   }
  }).catch(error=>{
   if(!live)return;
   if(error instanceof DigitalRequestError&&(error.status===401||error.status===403||error.status===404)){
    setSheet(null);
    setParticipants([]);
    setDisplayedRead(null);
   }
   setError(error instanceof Error?error.message:'报价读取失败');
  }).finally(()=>{if(live)setSettledRead(readKey);});
  return()=>{live=false;generation.current++;};
 },[base,history,readKey,initialHistory.error]);
 const mutate=async(path:string,method:string,body:unknown)=>{
  if(!canEditDisplayed||writing.current||uncertain)return;writing.current=true;setBusy(true);setError('');const epoch=generation.current;
  const op={path,method,body:JSON.parse(JSON.stringify(body)) as unknown,key:createClientRequestId(),startedAt:Date.now()};operation.current=op;
  try{const value=await quotationRequest(path,resource,method,op.body,op.key);if(epoch!==generation.current)return;install(value);operation.current=null;}
  catch(e){if(epoch!==generation.current)return;const unknown=e instanceof DigitalRequestError?e.resultUnknown:unknownWriteResult(e);setUncertain(unknown);if(!unknown)operation.current=null;setError(e instanceof Error?e.message:'报价提交失败，输入保留');}
  finally{if(epoch===generation.current){writing.current=false;setBusy(false);}}
 };
 const recover=async()=>{const op=operation.current;if(!op||writing.current||!uncertain)return;if(Date.now()-op.startedAt>=SUBMISSION_RECOVERY_WINDOW_MS){setError('已超过原请求安全恢复期限，请核对原报价版本，不能生成新请求重发');return;}const epoch=generation.current;writing.current=true;setBusy(true);try{const value=await quotationRequest(op.path,resource,op.method,op.body,op.key);if(epoch!==generation.current)return;install(value);setUncertain(false);operation.current=null;setError('');}catch(e){if(epoch===generation.current)setError(e instanceof Error?e.message:'原报价回执仍未确认');}finally{if(epoch===generation.current){writing.current=false;setBusy(false);}}};
 const reload=async()=>{if(refreshing||writing.current)return;if(!uncertain&&(dirty||confirmationDirty)&&!await confirmInApp('重新载入会丢弃本页未保存修改，确定继续？'))return;if(uncertain){try{const current=await quotationRequest(base,resource);setError(`当前报价 v${current.version}，原请求结果仍未确认；输入和请求标识保留`);}catch(e){setError(e instanceof Error?e.message:'读取失败');}return;}setRetry(v=>v+1);};
 const edit=(patch:Partial<BudgetDocument>)=>{setDocument(v=>({...v,...patch}));setDirty(true);setStructureDirty(true);};
 const rowEdit=(id:string,patch:Partial<BudgetRow>)=>{edit({rows:document.rows.map(row=>row.rowId===id?{...row,...patch}:row)});};
 const assignmentEdit=(id:string,patch:Partial<QuotationAssignment>)=>{setAssignments(v=>v.map(a=>a.rowId===id?{...a,...patch}:a));setDirty(true);setStructureDirty(true);};
 const add=(section:BudgetRow['section'])=>{const rowId=createClientRequestId();edit({rows:[...document.rows,{rowId,section,category:'',name:'',specification:'',unit:'',supplier:'',consumption:'',unitPrice:''}]});setAssignments(v=>[...v,{rowId,technicalAssigneeId:null,priceAssigneeId:section==='外发工序'?null:sheet!.designerId,priceRole:section==='外发工序'?'ie_reviewer':'sample_designer'}]);};
 const save=()=>{if(!sheet)return;const input=SaveQuotationSchema.safeParse({expectedVersion:sheet.version,document,assignments});if(!input.success){setError(input.error.issues[0]?.message??'请检查报价');return;}void mutate(base,'PUT',input.data);};
 const confirm=()=>{if(!sheet||dirty){setError('请先保存报价修改，再记录客户确认');return;}const input=QuotationConfirmationSchema.safeParse({expectedVersion:sheet.version,customerCode:sheet.customerCode,customerConfirmedTotal:confirmedTotal,amountScope:scope,quantity:scope==='order_total'?Number(quantity):null,quantityUnit:'件',currency:'人民币',taxBasis,sourceKind:'explicit_customer_confirmation',sourceField:'customerConfirmedTotal',templateVersion:'online-quotation-v1',evidenceNote:evidence,confirmedAt:confirmedDate?new Date(confirmedDate).toISOString():''});if(!input.success){setError(input.error.issues[0]?.message??'请补齐客户确认信息');return;}void mutate(`${base}/confirm`,'POST',input.data);};
 const readOnly=!sheet?.canStructure||Boolean(history)||uncertain||editingRowId!==null;
 const structureReadOnly=readOnly||Boolean(sheet?.automatic);
 const unitMismatches=new Set(sheet?.rows.filter(row=>row.technicalConsumptionIssue==='unit_mismatch').map(row=>row.rowId));
 const validDocument=BudgetDocumentSchema.safeParse(document),totals=validDocument.success?calculateBudget(validDocument.data):null;
 const back=digitalDetailReturnUrl(new URLSearchParams(window.location.search).get('returnTo'),import.meta.env.BASE_URL);
 return <Surface><section className="quotation-editor dx-doc-budget"><DocumentToolbar title="客户报价表" status={busy?'提交中':uncertain?'原提交结果待确认':dirty?'未保存修改':sheet?`v${sheet.version} · ${sheet.status==='confirmed'?'客户已确认':'协作草稿'}`:'读取中'}>
  {back&&<a className="dx-button dx-button--secondary" href={back}>返回原单</a>}<a href={urls.pageUrl('ui/digital-quotation')}>我的报价协作</a>{sheet?.canStructure&&<Button disabled={!canEditDisplayed||busy||uncertain||editingRowId!==null} onClick={save}>保存报价</Button>}
 </DocumentToolbar>{error&&<p role="alert">{error}</p>}{uncertain?<><Button disabled={busy} onClick={()=>void recover()}>使用原内容核对报价提交</Button><Button disabled={busy} onClick={()=>void reload()}>仅核对当前版本</Button></>:<Button disabled={busy||refreshing} onClick={()=>void reload()}>重新读取报价</Button>}
 {sheet&&<>{sheet.automatic&&<p>材料、用量与工艺按本单资料自动汇集。{sheet.complete?'报价资料已齐。':'仍有资料或负责人员待补齐。'}</p>}<div className="budget-heading"><p>设计编号：<strong>{sheet.designStyleNo}</strong></p><p>客户：{sheet.customerCode??'通用开发'}</p><p>客户当前确认版：{sheet.confirmedVersion??'尚未确认'}</p></div>
 {sheet.priorCraftRows?.length&&<details><summary>历史工艺报价（不计入本版金额）</summary><table><thead><tr><th>阶段</th><th>工艺</th><th>单位</th><th>原单价</th></tr></thead><tbody>{sheet.priorCraftRows.map(({row,stage})=><tr key={row.rowId}><td>{stage==='development'?'开发':'大货'}</td><td>{row.name}</td><td>{row.unit}</td><td>{row.unitPrice||'未填写'}</td></tr>)}</tbody></table></details>}
 <label>查看报价版本<select aria-label="查看报价版本" disabled={busy||uncertain} value={history??''} onChange={async e=>{const next=e.target.value?Number(e.target.value):undefined;if((dirty||confirmationDirty)&&!await confirmInApp('切换版本将丢弃未保存修改，继续？'))return;setHistory(next);}}><option value="">当前协作资料</option>{sheet.versions.map(v=><option key={v} value={v}>客户确认版 {v}</option>)}</select></label>
 <fieldset className="quotation-read-fields" disabled={!canEditDisplayed}>
 {sheet.status==='confirmed'&&sheet.canStructure&&<p>客户原确认版已保留。修改后保存为新协作草稿，须重新记录客户确认，才会提供新的预算对照。</p>}{!sheet.automatic&&sheet.fullCost&&<DocumentSection id="quote-basic" title="报价基本信息"><div className="budget-heading">{(['productCategory','fabricType','monthSeries','date','freight','cm','salePrice','outsourcingScope','outsourcingUnitPrice'] as const).map(key=><label key={key}>{({productCategory:'产品类别',fabricType:'面料属性',monthSeries:'月份系列',date:'报价日期',freight:'运费',cm:'CM加工费用',salePrice:'参考销售单价',outsourcingScope:'外发范围',outsourcingUnitPrice:'外发预算参考价'})[key]}<DocumentField id={`quote-${key}`} label={({productCategory:'产品类别',fabricType:'面料属性',monthSeries:'月份系列',date:'报价日期',freight:'运费',cm:'CM加工费用',salePrice:'参考销售单价',outsourcingScope:'外发范围',outsourcingUnitPrice:'外发预算参考价'})[key]} value={String(document[key]??'')} readonly={readOnly} disabled={busy} type={key==='date'?'date':'text'} onValue={value=>edit({[key]:key==='date'?value||null:value})}/></label>)}</div></DocumentSection>}
 <DocumentSection id="quote-rows" title={sheet.fullCost?'分项报价与责任分工':'我负责的报价明细'} detail="单件用量由技术填写；物料价格由设计填写；工艺价格由指定报价岗位填写">
 <DocumentTableScroll scrollLabel="报价明细，可左右滚动查看全部字段"><table><thead><tr><th>类别</th><th>物料或工序</th><th>规格</th><th>单位</th><th>供应方</th><th>单件用量</th><th>单价（不含税）</th>{sheet.fullCost&&<th>金额</th>}<th>技术用量负责人</th><th>价格负责人</th>{!structureReadOnly&&<th>操作</th>}</tr></thead><tbody>{(sheet.fullCost?document.rows:sheet.rows).map(row=>{const a=assignments.find(a=>a.rowId===row.rowId);return <tr key={row.rowId}>
 {(['section','name','specification','unit','supplier'] as const).map(key=><td key={key}>{key==='section'?row.section:<DocumentField id={`quote-${row.rowId}-${key}`} label={`${row.name||'物料'} ${{name:'物料或工序',specification:'规格',unit:'单位',supplier:'供应方'}[key]}`} value={row[key]} readonly={structureReadOnly} disabled={busy} onValue={value=>rowEdit(row.rowId,{[key]:value,...(['name','specification','unit'].includes(key)?{consumption:'',...(row.section==='外发工序'?{unitPrice:''}:{})}:{})})}/>}{key==='name'&&sheet.rows.find(value=>value.rowId===row.rowId)?.craftBasis&&<small>{sheet.rows.find(value=>value.rowId===row.rowId)!.craftBasis!.stage==='development'?'开发':'大货'} · 工艺版本 {sheet.rows.find(value=>value.rowId===row.rowId)!.craftBasis!.libraryVersion}</small>}</td>)}
 <td>{row.consumption??'无权查看'}{unitMismatches.has(row.rowId)&&<small>已发布技术用量单位与本行计价单位不符，请核对。</small>}{!structureReadOnly&&row.consumption!==''&&<Button type="button" disabled={busy} onClick={()=>rowEdit(row.rowId,{consumption:''})}>清空待技术重填</Button>}</td><td>{row.unitPrice===null?'无权查看':sheet.canStructure&&!sheet.automatic&&row.section!=='外发工序'&&!history?<DocumentField id={`quote-${row.rowId}-price`} label={`${row.name||'物料'}单价`} value={row.unitPrice} readonly={readOnly} disabled={busy} numeric onValue={value=>rowEdit(row.rowId,{unitPrice:value})}/>:row.unitPrice||'待填写'}</td>{sheet.fullCost&&<td>{row.consumption===''||row.unitPrice===''?'—':totals?budgetDisplayAmount(totals.rows.find(r=>r.rowId===row.rowId)?.amount??'0'):'当前输入待核'}</td>}
 <td>{!readOnly&&(!sheet.automatic||row.section!=='外发工序')?<select aria-label={`${row.name||'物料'}用量负责人`} value={a?.technicalAssigneeId??''} disabled={busy} onChange={e=>{assignmentEdit(row.rowId,{technicalAssigneeId:e.target.value||null});if(!sheet.automatic)rowEdit(row.rowId,{consumption:''});}}><option value="">待分派技术</option>{participants.filter(p=>p.role==='pattern_room_worker').map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select>:sheet.rows.find(r=>r.rowId===row.rowId)?.technicalAssigneeName??(a?.technicalAssigneeId?'指定技术资料待刷新':'待分派')}</td>
 <td>{row.section==='外发工序'&&!readOnly&&(!sheet.automatic||a?.priceRole!=='pattern_room_worker'||sheet.rows.find(value=>value.rowId===row.rowId)?.craftBasis?.stage==='bulk')?<select aria-label={`${row.name||'工序'}价格负责人`} disabled={busy} value={a?.priceAssigneeId?`${a.priceRole}:${a.priceAssigneeId}`:''} onChange={e=>{const [role,id]=e.target.value.split(':');assignmentEdit(row.rowId,{priceAssigneeId:id??null,priceRole:(role||'ie_reviewer') as QuotationAssignment['priceRole']});if(!sheet.automatic)rowEdit(row.rowId,{unitPrice:''});}}><option value="">待分派报价</option>{participants.filter(p=>sheet.automatic?p.role===a?.priceRole:p.role!=='pattern_room_worker').map(p=><option key={`${p.role}:${p.id}`} value={`${p.role}:${p.id}`}>{p.name} · {p.role==='ie_reviewer'?'IE':p.role==='pattern_room_worker'?'工艺师傅':'工艺跟单'}</option>)}</select>:sheet.rows.find(r=>r.rowId===row.rowId)?.priceAssigneeName??(row.section==='外发工序'?'指定工艺报价岗位':'本单设计')}</td>
 {!structureReadOnly&&<td><Button disabled={busy} onClick={()=>{edit({rows:document.rows.filter(r=>r.rowId!==row.rowId)});setAssignments(v=>v.filter(x=>x.rowId!==row.rowId));}}>删除明细</Button></td>}</tr>;})}</tbody></table></DocumentTableScroll>{!structureReadOnly&&BUDGET_SECTIONS.map(section=><Button key={section} disabled={busy||document.rows.length>=300} onClick={()=>add(section)}>添加{section}</Button>)}</DocumentSection>
 {!history&&sheet.rows.some(r=>r.canEditPricingUnit||r.canEditConsumption||r.canEditPrice&&(sheet.automatic||!sheet.canStructure||r.section==='外发工序'))&&<DocumentSection id="quote-own-fields" title="填写我负责的字段">{sheet.rows.filter(r=>r.canEditPricingUnit||r.canEditConsumption||r.canEditPrice&&(sheet.automatic||!sheet.canStructure||r.section==='外发工序')).map(row=><div className="quotation-row-input" key={row.rowId}><strong>{row.name} · {row.specification} · {row.unit}</strong>{row.canEditPricingUnit&&<label>计价单位<input aria-label={`${row.name}计价单位`} value={rowInputs[row.rowId]?.pricingUnit??row.unit} maxLength={100} disabled={busy||uncertain||structureDirty||editingRowId!==null&&editingRowId!==row.rowId} onChange={e=>{setEditingRowId(row.rowId);setRowInputs(v=>({...v,[row.rowId]:{...v[row.rowId],pricingUnit:e.target.value}}));setDirty(true);}}/><small>单位改变后仅重核本行用量，不自动换算。</small></label>}{row.pricingUnitSource&&<small>计价单位补正版 v{row.pricingUnitSource.version} · {new Date(row.pricingUnitSource.recordedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})}</small>}{row.canEditConsumption&&<label>单件用量<input aria-label={`${row.name}单件用量`} value={rowInputs[row.rowId]?.consumption??row.consumption??''} disabled={busy||uncertain||structureDirty||editingRowId!==null&&editingRowId!==row.rowId} onChange={e=>{setEditingRowId(row.rowId);setRowInputs(v=>({...v,[row.rowId]:{...v[row.rowId],consumption:e.target.value}}));setDirty(true);}}/></label>}{row.canEditConsumption&&sheet.technicalConsumptionOptions?.some(o=>o.unit===row.unit&&(!sheet.automatic||o.materialId===row.rowId))&&<div><label>采用本单已发布技术用量<select aria-label={`${row.name}采用技术用量`} value={adoptions[row.rowId]??''} disabled={busy||uncertain||dirty} onChange={e=>setAdoptions(v=>({...v,[row.rowId]:e.target.value}))}><option value="">请选择对应物料</option>{sheet.technicalConsumptionOptions.filter(o=>o.unit===row.unit&&(!sheet.automatic||o.materialId===row.rowId)).map(o=><option key={`${o.artifactSetId}:${o.artifactVersion}:${o.materialId}`} value={`${o.artifactSetId}:${o.artifactVersion}:${o.materialId}`}>{o.name} · {o.consumption}{o.unit} · v{o.artifactVersion}</option>)}</select></label><Button disabled={busy||uncertain||dirty||!adoptions[row.rowId]} onClick={()=>{const [id,version,materialId]=(adoptions[row.rowId]??'').split(':');if(id&&version&&materialId)void mutate(`${base}/rows/${row.rowId}`,'POST',{expectedVersion:sheet.version,artifactConsumption:{id,version:Number(version),materialId}});}}>明确采用到本行</Button><small>只采用当前选择的用量；技术成果变版不会自动改动已确认报价或预算。</small></div>}{row.canEditPrice&&(sheet.automatic||!sheet.canStructure||row.section==='外发工序')&&<label>单价<input aria-label={`${row.name}负责单价`} value={rowInputs[row.rowId]?.unitPrice??row.unitPrice??''} disabled={busy||uncertain||structureDirty||editingRowId!==null&&editingRowId!==row.rowId} onChange={e=>{setEditingRowId(row.rowId);setRowInputs(v=>({...v,[row.rowId]:{...v[row.rowId],unitPrice:e.target.value}}));setDirty(true);}}/></label>}<Button disabled={busy||uncertain||structureDirty||!rowInputs[row.rowId]} onClick={()=>void mutate(`${base}/rows/${row.rowId}`,'POST',{expectedVersion:sheet.version,...rowInputs[row.rowId]})}>保存本行负责字段</Button></div>)}</DocumentSection>}
 {sheet.fullCost&&<DocumentSection id="quote-cost-reference" title="内部成本参考（不含税）"><p>当前明细暂计：{totals?budgetDisplayAmount(totals.cost):'输入待核'} 元／件。客户确认金额须另按真实确认记录填写，本参考不自动作为客户确认价。</p>{document.rows.some(r=>r.consumption===''||r.unitPrice==='')&&<p>仍有用量或价格待负责岗位填写；暂计金额不表示报价资料已齐。</p>}</DocumentSection>}{sheet.confirmation&&<DocumentSection id="quote-confirmed-basis" title="客户确认依据"><p>客户确认{sheet.confirmation.amountScope==='per_piece'?'单件金额':'整单总额'}：{sheet.confirmation.customerConfirmedTotal} 元 · {sheet.confirmation.taxBasis==='excludes_tax'?'不含税':'含税'}{sheet.confirmation.quantity?` · ${sheet.confirmation.quantity}件`:''}</p><p>{sheet.confirmation.evidenceNote}</p><p>这是内部记录的客户确认事实，不等同于内部成本合计。</p></DocumentSection>}
 {!sheet.customerCode&&<p>客户尚未明确，可先协作报价草稿，不能记录客户确认。</p>}{sheet.canConfirm&&<DocumentSection id="quote-confirmation" title="记录客户报价确认"><p>请按客户实际确认的报价填写金额与口径，系统不会从旧Excel字段猜取金额。含税口径可记录，但须对齐后才能与当前不含税预算比较。</p><div className="budget-heading"><label>客户确认金额<input aria-label="客户确认金额" value={confirmedTotal} disabled={busy||uncertain} onChange={e=>{setConfirmedTotal(e.target.value);setConfirmationDirty(true);}}/></label><label>金额口径<select value={scope} disabled={busy||uncertain} onChange={e=>{setScope(e.target.value as typeof scope);setConfirmationDirty(true);}}><option value="per_piece">每件</option><option value="order_total">整单总额</option></select></label>{scope==='order_total'&&<label>确认件数<input aria-label="确认件数" value={quantity} disabled={busy||uncertain} onChange={e=>{setQuantity(e.target.value);setConfirmationDirty(true);}}/></label>}<label>税费口径<select value={taxBasis} disabled={busy||uncertain} onChange={e=>{setTaxBasis(e.target.value as typeof taxBasis);setConfirmationDirty(true);}}><option value="excludes_tax">不含税</option><option value="includes_tax">含税</option></select></label><label>客户真实确认时间<input type="datetime-local" value={confirmedDate} disabled={busy||uncertain} onChange={e=>{setConfirmedDate(e.target.value);setConfirmationDirty(true);}}/></label><label>确认依据与原记录位置<textarea aria-label="客户确认依据" value={evidence} disabled={busy||uncertain} maxLength={2000} onChange={e=>{setEvidence(e.target.value);setConfirmationDirty(true);}}/></label></div><Button variant="primary" disabled={busy||uncertain||dirty||sheet.complete===false} onClick={confirm}>记录客户报价确认并检查预算生成条件</Button></DocumentSection>}
 <p>{sheet.budget.state==='waiting_formal_order'?'等待正式下单；纯开发和预下单不强制生成预算':sheet.budget.state==='created'?`已生成预算草稿 v${sheet.budget.version}，由订单跟单复核发布`:sheet.budget.state==='review_required'?'客户报价已变版，预算需跟单复核；已进入外发的沿原更正入口办理，原合同不自动改变':sheet.budget.state==='legacy_published'?'历史预算保留原版本，不自动改用新规则':'等待客户确认报价'}</p>{sheet.productionOrderId&&sheet.fullCost&&<a href={urls.pageUrl(`ui/digital-production?budget=${sheet.productionOrderId}`)}>打开本单预算</a>}
 </fieldset></>}
 </section></Surface>;
}
