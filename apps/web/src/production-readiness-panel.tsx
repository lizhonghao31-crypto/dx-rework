import {Selector} from '@astryxdesign/core/Selector';
import {TextArea} from '@astryxdesign/core/TextArea';
import {FileInput} from '@astryxdesign/core/FileInput';
import {DevelopmentEntryAction} from './development-entry-controls.js';
import {canLeaveInternalPage} from './internal-navigation.js';
import {SubmissionRequestError} from './submission-validation.js';
import {confirmInApp} from './system-dialog.js';
import {businessRoleLabel} from '@dx-rework/contracts/business-display';
import {useEffect,useRef,useState} from 'react';
import {Button} from '@dx-rework/ui';
import {preparationMaterialLabels,PREPARATION_MATERIAL_KINDS,preparationInvestmentRowKey,type PreparationMaterialFact,type PreparationMaterialKind,type PreparationResource,type ProductionReadinessState,type PreparationWindow} from '@dx-rework/contracts/production-readiness';
import {digitalRequest,DigitalRequestError} from './digital-production-api.js';
import {createClientRequestId} from './client-request-id.js';
import {SearchableSelect} from './search-select.js';
import {SubmissionAttempt} from './submission-attempt.js';
import {useTodoContentRead} from './todo-content-read.js';
import {useDigitalDetailNavigationGuard} from './use-digital-detail-navigation-guard.js';
import {uploadDevelopmentMaterial} from './digital-development-upload.js';
import {createWebUrls} from '../url-contract.js';
import './production-readiness.css';
const urls=createWebUrls(import.meta.env.BASE_URL);
const handoverStates=[
 {value:'ready',label:'本项已完成 / 备齐'},{value:'partial',label:'部分完成'},
 {value:'unknown',label:'实际情况未知'},{value:'withdrawn',label:'撤回原记录'},
];
const local=(value:string|null)=>value?new Date(Date.parse(value)+8*3600000).toISOString().slice(0,16):'';
const instant=(value:string)=>value?new Date(`${value}:00+08:00`).toISOString():null;
const investmentRowTime=(fact:PreparationMaterialFact|undefined,index:number|null)=>{
 const row=index===null?undefined:fact?.quantities[index];
 return row?fact?.investmentQuantityOccurrences?.[preparationInvestmentRowKey(row)]?.occurredAt??null:null;
};
const materialEntryTime=(kind:PreparationMaterialKind,fact:PreparationMaterialFact|undefined)=>
 kind==='material_investment'?investmentRowTime(fact,0):fact?.occurredAt??null;
const time=(value:string|null)=>value?new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'}):'未形成可信时间';
const statusLabels={waiting:'等待前提',running:'计时中',overdue:'已逾期',completed_on_time:'已按时完成',completed_late:'已逾期完成',unknown:'时效不可评估'};
export function PreparationWindows({state}:{state:ProductionReadinessState}){
 const duration=(w:PreparationWindow)=>w.minutes===null?'用时待补':w.minutes%1440===0?`${w.minutes/1440}天`:w.minutes%60===0?`${w.minutes/60}小时`:`${w.minutes}分钟`;
 const window=(name:string,w:PreparationWindow)=><div><strong>{name}</strong><span>{statusLabels[w.status]}</span><small>起点：{time(w.startedAt)} · 截止：{time(w.dueAt)}{w.completedAt&&` · 实际：${time(w.completedAt)}`}</small>{w.reason&&<small>{w.reason}</small>}</div>;
 return state.enrolled?<section className="preparation-readiness-windows" aria-label="跟单制单时效">{window(`制单草稿 · 到仓后${duration(state.draftWindow)}`,state.draftWindow)}{window(`正式制单 · 前提齐后${duration(state.finalWindow)}`,state.finalWindow)}<p>两个窗口独立计时。验布不合格不停止已有计时；质量条件仍须满足。客户约定、系统计划和实绩分别保留。</p></section>:null;
}
export function ProductionReadinessPanel({resource,sourceDocumentVersion,focusKind,lines=[],readonly=false,onChanged,handoverSubmitLabel,designHandoverOnly=false,investmentOnly=false}:{resource:PreparationResource;sourceDocumentVersion?:number|undefined;focusKind?:PreparationMaterialKind;lines?:Array<{lineId:string;color:string}>;readonly?:boolean;onChanged?:()=>void;handoverSubmitLabel?:string;designHandoverOnly?:boolean;investmentOnly?:boolean}){
 const base=`${resource.kind==='order'?'orders':'sources'}/${resource.id}/production-readiness`;
 const locator=useRef<HTMLElement>(null),located=useRef('');
 const requestedKind=designHandoverOnly?null:investmentOnly?'material_investment':focusKind??(typeof window==='undefined'?null:new URLSearchParams(window.location.search).get('materialKind'));
 const showOtherActions=!designHandoverOnly&&!investmentOnly;
 const [sheet,setSheet]=useState<ProductionReadinessState|null>(null),[error,setError]=useState(''),[receipt,setReceipt]=useState(''),[busy,setBusy]=useState(false),[expanded,setExpanded]=useState(designHandoverOnly);
 const [kind,setKind]=useState<PreparationMaterialKind>('design_handover'),[state,setState]=useState<'ready'|'partial'|'unknown'|'withdrawn'>('ready'),[at,setAt]=useState(''),[note,setNote]=useState(''),[name,setName]=useState(''),[quantity,setQuantity]=useState(''),[quantityIndex,setQuantityIndex]=useState<number|null>(null),[materialId,setMaterialId]=useState(''),[unit,setUnit]=useState(''),[lineId,setLineId]=useState(''),[recipient,setRecipient]=useState(''),[evidence,setEvidence]=useState<string[]>([]),[dirty,setDirty]=useState(false),[editingVersion,setEditingVersion]=useState(0),[editingDocumentVersion,setEditingDocumentVersion]=useState<number|null>(sourceDocumentVersion??null),[file,setFile]=useState<File|null>(null);
 const [people,setPeople]=useState<Array<{id:string;displayName:string;roles:string[]}>>([]),[warehouse,setWarehouse]=useState(''),[color,setColor]=useState(''),[colorRole,setColorRole]=useState(''),[reason,setReason]=useState(''),[responsibilityDirty,setResponsibilityDirty]=useState(false),[responsibilityVersion,setResponsibilityVersion]=useState(0),[adoptionReason,setAdoptionReason]=useState(''),[adoptionDirty,setAdoptionDirty]=useState(false);
 const [deliveryRecipient,setDeliveryRecipient]=useState(''),[deliveryAt,setDeliveryAt]=useState(''),[deliveryNote,setDeliveryNote]=useState(''),[deliveryVersion,setDeliveryVersion]=useState(''),[deliveryDirty,setDeliveryDirty]=useState(false);
 const [reminderCloseReason,setReminderCloseReason]=useState('');
 const [proofMaterial,setProofMaterial]=useState(''),[proofNote,setProofNote]=useState(''),[proofFile,setProofFile]=useState<File|null>(null),[proofAttachment,setProofAttachment]=useState<string|null>(null);
 type Form='materials'|'responsibility'|'delivery'|'adoption'|'materialReminder'|'investmentApplicability';
 const writing=useRef(false),attempts=useRef({materials:new SubmissionAttempt(),responsibility:new SubmissionAttempt(),delivery:new SubmissionAttempt(),adoption:new SubmissionAttempt(),materialReminder:new SubmissionAttempt(),investmentApplicability:new SubmissionAttempt()}),activeForm=useRef<Form>('materials'),mounted=useRef(true),context=useRef(0);
 const responsibilityEdited=useRef(false);responsibilityEdited.current=responsibilityDirty;
 const pending=Object.values(attempts.current).some(a=>a.hasPending);
 useDigitalDetailNavigationGuard(dirty||responsibilityDirty||deliveryDirty||adoptionDirty||Boolean(reminderCloseReason.trim()||proofMaterial||proofNote||proofFile),busy||pending,writing,'本次物料、人员或交付记录尚未保存，确认离开？');
 const handoverVersion=(value:ProductionReadinessState|null)=>value?.orderInstructionVersion===undefined
  ?value?.sourceDocumentVersion??sourceDocumentVersion??null:value.orderInstructionVersion;
 const usesInstruction=sheet!==null&&(sheet.orderInstructionVersion!==undefined||!sheet.sourceId);
 const apply=(next:ProductionReadinessState)=>{setSheet(next);if(responsibilityEdited.current)return;setResponsibilityVersion(next.responsibility.version);setWarehouse(next.responsibility.warehouseWorkerId??'');setColor(next.responsibility.colorConfirmationWorkerId??'');setColorRole(next.responsibility.colorConfirmationRole??'');};
 useEffect(()=>{let live=true;context.current++;writing.current=false;setBusy(false);mounted.current=true;setSheet(null);setError('');setReceipt('');setExpanded(designHandoverOnly);setDirty(false);setKind('design_handover');setState('ready');setAt('');setNote('');setName('');setQuantity('');setQuantityIndex(null);setMaterialId('');setUnit('');setLineId('');setRecipient('');setEvidence([]);setFile(null);setReason('');setDeliveryVersion('');setDeliveryRecipient('');setDeliveryAt('');setDeliveryNote('');setReminderCloseReason('');setProofMaterial('');setProofNote('');setProofFile(null);setProofAttachment(null);attempts.current={materials:new SubmissionAttempt(),responsibility:new SubmissionAttempt(),delivery:new SubmissionAttempt(),adoption:new SubmissionAttempt(),materialReminder:new SubmissionAttempt(),investmentApplicability:new SubmissionAttempt()};setResponsibilityDirty(false);responsibilityEdited.current=false;setDeliveryDirty(false);setAdoptionDirty(false);setAdoptionReason('');void digitalRequest<ProductionReadinessState>(base).then(async value=>{if(!live)return;apply(value);setEditingDocumentVersion(handoverVersion(value));setEditingVersion(value.facts.find(f=>f.kind==='design_handover'&&f.scopeRef==='whole')?.version??0);if(!investmentOnly&&((!designHandoverOnly&&value.canAssign)||(!readonly&&value.canRecord.includes('design_handover')))){const candidates=await digitalRequest<typeof people>('access/candidates');if(live)setPeople(candidates);}}).catch(e=>{if(live)setError(e.message);});return()=>{live=false;mounted.current=false;};},[base,designHandoverOnly,investmentOnly,readonly]);
 const choose=async(next:PreparationMaterialKind)=>{if(dirty&&!await confirmInApp('切换办理项会放弃本次未保存输入，确认切换？'))return;if(writing.current)return;const fact=sheet?.facts.find(f=>f.kind===next&&f.scopeRef==='whole');setKind(next);setEditingVersion(fact?.version??0);setEditingDocumentVersion(handoverVersion(sheet));setState(fact?.state??'ready');setAt(local(materialEntryTime(next,fact)));setNote('');setEvidence(fact?.evidenceIds??[]);setRecipient(fact?.recipientId??'');setQuantityIndex(fact?.quantities.length?0:null);setMaterialId(fact?.quantities[0]?.materialId??'');setName(fact?.quantities[0]?.name??'');setQuantity(fact?.quantities[0]?.quantity.toString()??'');setUnit(next==='style_label_ready'?'枚':fact?.quantities[0]?.unit??'');setLineId(fact?.quantities[0]?.lineId??'');setDirty(false);setFile(null);};
 const feedback=async(operation:()=>Promise<void>,retry=false)=>{
  if(writing.current)return;const generation=context.current,active=attempts.current[activeForm.current];writing.current=true;setBusy(true);setError('');setReceipt('');
  const adapted=async()=>{try{await operation();}catch(error){if(error instanceof DigitalRequestError&&!error.resultUnknown)throw new SubmissionRequestError(error.message,error.code,error.status??500);throw error;}};
  try{const result=retry?await active.retry():await active.run(adapted);if(!mounted.current||generation!==context.current)return;
   if(result.kind==='failure')setError(result.failure.message);else if(result.kind==='needs-recovery')setError('上次结果尚未确认，请使用原内容核对');else if(result.kind==='expired')setError('原请求已超过安全恢复窗口，请管理员核对原记录，不重复新增');
  }finally{if(generation===context.current){writing.current=false;if(mounted.current)setBusy(false);}}
 };
 const send=(path:string,input:unknown,method='POST')=>{if(writing.current||pending)return;const form:Form=path==='/materials'?'materials':path==='/responsibility'?'responsibility':path==='/instruction-deliveries'?'delivery':path==='/material-investment-reminder/close'?'materialReminder':path==='/material-investment/confirm-applicability'?'investmentApplicability':'adoption';activeForm.current=form;const key=createClientRequestId(),generation=context.current,active=attempts.current[form];return feedback(async()=>{const result=await digitalRequest<ProductionReadinessState>(base+path,method,input,key);active.markConfirmed();if(!mounted.current||generation!==context.current)return;
  if(form==='responsibility'){responsibilityEdited.current=false;setResponsibilityDirty(false);}apply(result);
  if(form==='materials'){setEditingVersion(result.facts.find(f=>f.kind===(input as {kind:string}).kind&&f.scopeRef==='whole')?.version??0);if(quantityIndex===null&&quantity&&name&&unit)setQuantityIndex((input as {quantities:unknown[]}).quantities.length-1);setDirty(false);}
  if(form==='materialReminder')setReminderCloseReason('');if(form==='investmentApplicability'){setProofMaterial('');setProofNote('');setProofFile(null);setProofAttachment(null);}if(form==='delivery')setDeliveryDirty(false);if(form==='adoption')setAdoptionDirty(false);setReceipt('已保存原业务记录');onChanged?.();});};
 useEffect(()=>{if(!sheet||sheet.resource.kind!==resource.kind||sheet.resource.id!==resource.id||!requestedKind||!(PREPARATION_MATERIAL_KINDS as readonly string[]).includes(requestedKind))return;
  const stamp=base+':'+requestedKind;if(located.current===stamp)return;located.current=stamp;if(dirty||writing.current)return;
  setExpanded(true);if(!readonly&&sheet.canRecord.includes(requestedKind as PreparationMaterialKind))void choose(requestedKind as PreparationMaterialKind);
  const frame=requestAnimationFrame(()=>{const target=[...(locator.current?.querySelectorAll<HTMLElement>('[data-preparation-kind]')??[])].find(e=>e.dataset.preparationKind===requestedKind);target?.scrollIntoView({block:'center'});(target?.querySelector<HTMLElement>('button')??target)?.focus({preventScroll:true});});return()=>cancelAnimationFrame(frame);
 },[base,sheet,requestedKind]);
 const reload=async()=>{if(!await canLeaveInternalPage())return;setDirty(false);setResponsibilityDirty(false);responsibilityEdited.current=false;setDeliveryDirty(false);setAdoptionDirty(false);const generation=context.current;setBusy(true);setError('');void digitalRequest<ProductionReadinessState>(base).then(async result=>{if(mounted.current&&generation===context.current){apply(result);const fact=result.facts.find(f=>f.kind===kind&&f.scopeRef==='whole');setEditingDocumentVersion(handoverVersion(result));setEditingVersion(fact?.version??0);setState(fact?.state??'ready');setAt(local(materialEntryTime(kind,fact)));setNote('');setEvidence(fact?.evidenceIds??[]);setRecipient(fact?.recipientId??'');setQuantityIndex(fact?.quantities.length?0:null);setMaterialId(fact?.quantities[0]?.materialId??'');setName(fact?.quantities[0]?.name??'');setQuantity(fact?.quantities[0]?.quantity.toString()??'');setUnit(kind==='style_label_ready'?'枚':fact?.quantities[0]?.unit??'');setLineId(fact?.quantities[0]?.lineId??'');setFile(null);setReason('');setDeliveryVersion('');setDeliveryRecipient('');setDeliveryAt('');setDeliveryNote('');setAdoptionReason('');setReceipt('已重新读取，未改写资料或计划');if(result.canAssign||result.canRecord.includes('design_handover')){const candidates=await digitalRequest<typeof people>('access/candidates');if(mounted.current&&generation===context.current)setPeople(candidates);}}}).catch(error=>{if(mounted.current&&generation===context.current)setError(error.message);}).finally(()=>{if(mounted.current&&generation===context.current)setBusy(false);});};
 const touch=(action:()=>void)=>{action();setDirty(true);};
 const submit=()=>{if(!sheet)return;const prior=sheet.facts.find(f=>f.kind===kind&&f.scopeRef==='whole');
  const quantities=[...(prior?.quantities??[])],selected=quantityIndex===null?null:quantities[quantityIndex];
  if(quantity||name||unit){
   if(!quantity||!name.trim()||!unit.trim()||!Number.isFinite(Number(quantity))||Number(quantity)<=0){setError('请完整填写当前物料名称、正数数量及单位；其它物料明细保持原值');return;}
   const value={lineId:lineId||null,materialId:kind==='material_investment'&&materialId?materialId:selected?.name===name&&selected.unit===unit?selected.materialId:null,name,quantity:Number(quantity),unit};
   if(quantityIndex===null)quantities.push(value);else quantities[quantityIndex]=value;
  }else if(selected){setError('原物料明细不能通过清空输入悄然删除，请保留数量或明确追加订正原因');return;}
  // A correction identifies its original row in the exact version being edited.
  const activeInvestment=kind==='material_investment'&&['ready','partial'].includes(state);
  if(activeInvestment&&!at){setError('请填写本次实际发生时间');return;}
  const correction=activeInvestment&&selected&&quantityIndex!==null?{index:quantityIndex,previous:selected}:null;
  const submitted=correction?[quantities[correction.index]!]:quantities;
  const originalAt=correction?investmentRowTime(prior,correction.index):null;
  const occurredAt=state==='unknown'||state==='withdrawn'?null
   :originalAt&&at===local(originalAt)?originalAt:instant(at);
  void send('/materials',{kind,scopeRef:'whole',expectedVersion:editingVersion,...(kind==='material_investment'&&materialId&&['ready','partial'].includes(state)?{investmentMaterialId:materialId}:{}),
   ...(correction?{investmentQuantityCorrection:correction}:{}),state,occurredAt,note,quantities:submitted,evidenceIds:evidence,sourceDocumentVersion:kind==='design_handover'&&!usesInstruction?editingDocumentVersion:null,
   ...(kind==='design_handover'&&usesInstruction&&editingDocumentVersion?{orderInstructionVersion:editingDocumentVersion}:{}),recipientId:kind==='design_handover'?recipient||null:null});
 };
 const entryControls=designHandoverOnly||Boolean(handoverSubmitLabel),Action=entryControls?DevelopmentEntryAction:Button;
 const personSelect=(label:string,selected:string,onSelect:(value:string)=>void,filter:(p:typeof people[number])=>boolean,form:Form='materials')=>{
  const options=[{value:'',label:'待指定'},...people.filter(filter).map(p=>({value:p.id,label:p.displayName}))];
  const change=(value:string)=>{onSelect(value);if(form==='responsibility')setResponsibilityDirty(true);else setDirty(true);};
  return entryControls?<Selector label={label} size="sm" hasSearch searchPlaceholder="搜索姓名" options={options} value={selected}
    isDisabled={busy||pending} onChange={change}/>
   :<label>{label}<SearchableSelect aria-label={label} value={selected} onChange={event=>change(event.target.value)}>
     {options.map(option=><option key={option.value} value={option.value}>{option.label}</option>)}</SearchableSelect></label>;
 };
 const readMaterialTodo=useTodoContentRead({routeName:resource.kind==='source'?'digital_source_material_investment':'digital_order_material_investment',
  entityId:resource.id},Boolean(expanded&&requestedKind==='material_investment'&&sheet?.resource.id===resource.id&&sheet.canRecord.includes('material_investment')));
 if(!sheet)return <section className="preparation-readiness">{error?<p role="alert">{error}</p>:<p role="status">正在读取产前物料…</p>}<Action disabled={busy} onClick={reload}>重新读取</Action></section>;
 const disabled=busy||pending;
 const shownKinds:readonly PreparationMaterialKind[]=designHandoverOnly?['design_handover']:investmentOnly?['material_investment']:PREPARATION_MATERIAL_KINDS;
 const shownHistory=showOtherActions?sheet.history:sheet.history.filter(f=>shownKinds.includes(f.kind));
 const factCount=sheet.facts.filter(f=>shownKinds.includes(f.kind)&&f.state==='ready'&&f.valid).length;
 const selectedFact=sheet.facts.find(f=>f.kind===kind&&f.scopeRef==='whole');
 const handover=sheet.facts.find(row=>row.kind==='design_handover'&&row.scopeRef==='whole'&&row.state==='ready'&&row.valid);
 const handedMaterials=(handover?.handoverMaterials??[]).filter(row=>row.materialId&&handover?.investmentScopeBasis?.materialIds.includes(row.materialId));
 const applicability=sheet.preorderApplicabilityCandidates??[],chosenProof=applicability.find(candidate=>candidate.materialId===proofMaterial);
 const uploadProof=async()=>{
  if(!proofFile||writing.current||pending)return;
  const generation=context.current;writing.current=true;setBusy(true);setError('');
  try{const limits=await digitalRequest<{maxUploadBytes:number}>(`${base}/upload-limits`);
   const attachment=await uploadDevelopmentMaterial(base,proofFile,'工艺开发板',limits.maxUploadBytes);
   if(mounted.current&&generation===context.current){setProofAttachment(attachment);setProofFile(null);}
  }catch(error){if(mounted.current&&generation===context.current)setError(error instanceof Error?error.message:'原投料凭证上传未完成');}
  finally{if(generation===context.current){writing.current=false;if(mounted.current)setBusy(false);}}
 };

 return <section ref={locator} className="preparation-readiness">{showOtherActions&&<PreparationWindows state={sheet}/>}<details open={expanded} onToggle={e=>setExpanded(e.currentTarget.open)}><summary>{designHandoverOnly?'原设计资料交接':investmentOnly?'本单投面辅料记录':'产前物料办理'} · {factCount}项已有记录</summary>
 <Action variant="secondary" disabled={disabled} onClick={reload}>{designHandoverOnly?'刷新交接记录':'刷新物料记录'}</Action>{showOtherActions&&<p>本页登记原物料和交接事实，复用已有凭证。部分备料不代表整单齐料；款号唛须为进裁床前的实物。</p>}
 {!designHandoverOnly&&handover?.preorderApplicability?.quantityDemand&&<ul aria-label="有效需求变更与原实际投料">
  {Object.entries(handover.preorderApplicability.quantityDemand).map(([id,row])=><li key={id}>
   {handedMaterials.find(material=>material.materialId===id)?.name} · 现需 {row.requested} {row.unit} · 实投 {row.originallyRecorded} {row.unit} · 差额 {row.remaining} {row.unit}
  </li>)}
 </ul>}
 {!readonly&&!designHandoverOnly&&applicability.length>0&&<fieldset aria-label="确认原已投材料补齐资料" disabled={disabled}>
  <legend>确认原已投材料补齐资料</legend>
  <label>本次补齐的原材料<select value={proofMaterial} onChange={event=>{setProofMaterial(event.target.value);setProofAttachment(null);setProofFile(null);}}>
   <option value="">请选择</option>{applicability.map(candidate=><option value={candidate.materialId} key={candidate.materialId}>{candidate.name}</option>)}
  </select></label>
  {chosenProof&&<><p>{chosenProof.reason}</p><label>原实物凭证<input type="file" accept="image/jpeg,image/png,image/webp,application/pdf"
   onChange={event=>{setProofAttachment(null);setProofFile(event.target.files?.[0]??null);}}/></label>
   {proofFile&&<Action variant="secondary" onClick={()=>void uploadProof()}>上传原实物凭证</Action>}
   {proofAttachment&&<p role="status">原实物凭证已就绪</p>}
   <label>同一实际材料确认说明<textarea value={proofNote} maxLength={1000} onChange={event=>setProofNote(event.target.value)}/></label>
   <Action disabled={!proofAttachment||!proofNote.trim()} onClick={()=>void send('/material-investment/confirm-applicability',{
    materialId:chosenProof.materialId,sourceVersion:chosenProof.sourceVersion,roundNumber:chosenProof.roundNumber,
    handover:chosenProof.handover,investment:chosenProof.investment,note:proofNote,evidenceIds:[proofAttachment],
   })}>确认采用原实际投料</Action></>}
 </fieldset>}
 {!designHandoverOnly&&sheet.materialInvestmentReminder&&<div aria-label="投面辅料提醒">
  <strong>投面辅料截止：{time(sheet.materialInvestmentReminder.dueAt)}{sheet.materialInvestmentReminder.exclusive?' 前':''}</strong>
  {sheet.materialInvestmentReminder.termination?<p>{sheet.materialInvestmentReminder.status==='overdue'?'已终止，本项终止前已逾期':'本项计时已终止'}</p>
   :sheet.materialInvestmentReminder.closed?<p>提醒已关闭：{sheet.materialInvestmentReminder.closed.reason}。仍可继续登记实际投面辅料。</p>
   :sheet.materialInvestmentReminder.enabled&&sheet.materialInvestmentReminder.status!=='waiting'&&
    <p>{sheet.materialInvestmentReminder.status==='overdue'?'投面辅料已逾期':'投面辅料临近截止'}</p>}
  {!readonly&&sheet.materialInvestmentReminder.canClose
   &&sheet.materialInvestmentReminder.status!=='waiting'&&!sheet.materialInvestmentReminder.closed&&<div>
   <label>关闭提醒原因<input value={reminderCloseReason} maxLength={1000} onChange={event=>setReminderCloseReason(event.target.value)}/></label>
   <Action variant="secondary" disabled={disabled||!reminderCloseReason.trim()} onClick={()=>void send('/material-investment-reminder/close',
    {fingerprint:sheet.materialInvestmentReminder!.fingerprint,reason:reminderCloseReason})}>关闭提醒</Action></div>}
 </div>}
 <div className="preparation-readiness-facts">{shownKinds.map(k=>{const fact=sheet.facts.find(f=>f.kind===k&&f.scopeRef==='whole');return <div key={k} data-preparation-kind={k} ref={k==='material_investment'?readMaterialTodo:undefined} tabIndex={-1}><strong>{preparationMaterialLabels[k]}</strong><span>{!fact?'未登记':!fact.valid?'凭证已失效':fact.state==='ready'?'已记录':fact.state==='partial'?'部分完成':fact.state==='withdrawn'?'已撤回':'实际情况未知'}{fact&&` · 第${fact.version}版`}</span>{fact&&<small>{fact.note}</small>}{fact?.handoverMaterials?.map((m,i)=><small key={i}>{m.name} · {m.quantity||"数量未定"} · {m.color} · {m.specification}{m.supplier&&` · 供应商：${m.supplier}`}</small>)}{!readonly&&sheet.canRecord.includes(k)&&<Action variant="secondary" disabled={disabled} onClick={()=>void choose(k)}>{fact?'追加订正':'登记'}</Action>}</div>;})}</div>
 {!readonly&&(!investmentOnly||kind==='material_investment')&&sheet.canRecord.includes(kind)&&<fieldset disabled={disabled}><legend>{preparationMaterialLabels[kind]}{kind==='design_handover'?` · ${usesInstruction?'本单制单资料':sheet.sourceIsPreorderDraft?'投料草稿':'发布资料'}第${editingDocumentVersion??'未保存'}版`:''}</legend>{Boolean(selectedFact?.quantities.length)&&<label>本次修改的物料明细<select disabled={dirty} value={quantityIndex===null?'new':String(quantityIndex)} onChange={e=>{const index=e.target.value==='new'?null:Number(e.target.value),row=index===null?null:selectedFact!.quantities[index];setQuantityIndex(index);if(kind==='material_investment')setAt(local(investmentRowTime(selectedFact,index)));setMaterialId(row?.materialId??'');setName(row?.name??'');setQuantity(row?.quantity.toString()??'');setUnit(kind==='style_label_ready'?'枚':row?.unit??'');setLineId(row?.lineId??'');}}>{selectedFact!.quantities.map((q,i)=><option key={i} value={i}>{q.name} · {q.quantity}{q.unit}</option>)}<option value="new">新增另一物料（保留原明细）</option></select><small>一次订正一条；有未保存输入时先保存或重新选择本办理项，其它明细不会被覆盖。</small></label>}<div className="preparation-readiness-fields">{entryControls&&kind==='design_handover'?<Selector label="办理状态" size="sm" value={state} isDisabled={disabled} options={handoverStates}
   onChange={value=>touch(()=>setState(value as typeof state))}/>
   :<label>办理状态<select value={state} onChange={e=>touch(()=>setState(e.target.value as typeof state))}>
     {handoverStates.map(option=><option key={option.value} value={option.value}>{option.label}</option>)}</select></label>}{!['unknown','withdrawn'].includes(state)&&<label>实际发生时间（北京时间）<input type="datetime-local" value={at} onChange={e=>touch(()=>setAt(e.target.value))}/></label>}
 {kind==='design_handover'&&personSelect('接收订单跟单',recipient,setRecipient,p=>p.roles.includes('order_merchandiser'))}
 {['material_investment','fabric_receipt','accessories_ready','style_label_ready'].includes(kind)&&<>{kind==='material_investment'&&handedMaterials.length?<label>本次交接物料<select value={materialId} onChange={e=>{const id=e.target.value,material=handedMaterials.find(row=>row.materialId===id);touch(()=>{setMaterialId(id);setName(material?.name??'');});}}>
 <option value="">{name||'请选择已交接物料'}</option>{handedMaterials.map(row=><option key={row.materialId} value={row.materialId}>{row.name}{row.quantity?` · ${row.quantity}`:''}{row.supplier?` · ${row.supplier}`:''}</option>)}</select></label>:
 <label>物料名称<input maxLength={200} value={name} onChange={e=>touch(()=>setName(e.target.value))}/></label>}<label>对应款色<select value={lineId} onChange={e=>touch(()=>setLineId(e.target.value))}><option value="">整款 / 尚未形成正式款色</option>{(lines.length?lines:sheet.lines).map(l=><option key={l.lineId} value={l.lineId}>{l.color}</option>)}</select></label><label>实际数量<input type="number" min="0" step={kind==='style_label_ready'?'1':'any'} value={quantity} onChange={e=>touch(()=>setQuantity(e.target.value))}/></label><label>单位<input readOnly={kind==='style_label_ready'} maxLength={20} value={unit} onChange={e=>touch(()=>setUnit(e.target.value))}/></label></>}
 </div>{entryControls&&kind==='design_handover'?<TextArea label="本次情况 / 订正原因" maxLength={1000} value={note}
   isDisabled={disabled} onChange={value=>touch(()=>setNote(value.slice(0,1000)))}/>
   :<label>本次情况 / 订正原因<textarea maxLength={1000} value={note} onChange={e=>touch(()=>setNote(e.target.value))}/></label>}<div className="preparation-readiness-files">{evidence.map((id,i)=><span key={id}><a href={urls.apiUrl(`digital-production/${base}/attachments/${id}`)} target="_blank" rel="noreferrer">查看凭证{i+1}</a><Action variant="secondary" onClick={()=>touch(()=>setEvidence(evidence.filter(f=>f!==id)))}>移除引用</Action></span>)}</div>
 {entryControls&&kind==='design_handover'?<FileInput label="补充凭证（可选，图片或PDF）" accept="image/jpeg,image/png,image/webp,application/pdf"
    value={file} isDisabled={disabled} onChange={value=>touch(()=>setFile(Array.isArray(value)?value[0]??null:value))}/>
    :<label>补充凭证（可选，图片或PDF）<input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" onChange={e=>touch(()=>setFile(e.target.files?.[0]??null))}/></label>}{file&&<Action variant="secondary" onClick={()=>{if(writing.current)return;const generation=context.current,selected=file!;writing.current=true;setBusy(true);setError('');void (async()=>{try{const limits=await digitalRequest<{maxUploadBytes:number}>(`${base}/upload-limits`);const id=await uploadDevelopmentMaterial(base,selected,'工艺开发板',limits.maxUploadBytes);if(mounted.current&&generation===context.current){setEvidence(ids=>[...new Set([...ids,id])]);setFile(null);setDirty(true);setReceipt('凭证已就绪，请保存本次物料记录');}}catch(error){if(mounted.current&&generation===context.current)setError(error instanceof Error?error.message:'凭证上传未完成，原文件仍保留');}finally{if(generation===context.current){writing.current=false;if(mounted.current)setBusy(false);}}})();}}>上传所选凭证</Action>}
 <Action disabled={!note.trim()||Boolean(file)} onClick={submit}>{kind==='design_handover'&&handoverSubmitLabel?handoverSubmitLabel:'保存本项记录'}</Action></fieldset>}
 {showOtherActions&&sheet.canAssign&&!readonly&&<details><summary>指定仓管和对色确认人</summary><fieldset disabled={disabled}>{personSelect('本单收料仓管',warehouse,setWarehouse,p=>p.roles.some(r=>['warehouse_receiver','warehouse_supervisor'].includes(r)),'responsibility')}{personSelect('对色确认人',color,value=>{setColor(value);setColorRole('');},()=>true,'responsibility')}{color&&<label>其现有岗位<select value={colorRole} onChange={e=>{setColorRole(e.target.value);setResponsibilityDirty(true);}}><option value="">请选择已有岗位</option>{people.find(p=>p.id===color)?.roles.map(r=><option key={r} value={r}>{businessRoleLabel(r)}</option>)}</select></label>}<label>安排原因<input value={reason} maxLength={1000} onChange={e=>{setReason(e.target.value);setResponsibilityDirty(true);}}/></label><Action disabled={!reason.trim()||Boolean(color)!==Boolean(colorRole)} onClick={()=>void send('/responsibility',{expectedVersion:responsibilityVersion,warehouseWorkerId:warehouse||null,colorConfirmationWorkerId:color||null,colorConfirmationRole:colorRole||null,reason},'PUT')}>保存人员安排</Action><p>只指定已有有效岗位，不在此授予新权限。原产前派工已有仓管时，以原派工为准。</p></fieldset></details>}
 {showOtherActions&&!readonly&&!sheet.enrolled&&resource.kind==='order'&&<section><p>{sheet.adoptionReason}</p><label>采用理由<input maxLength={1000} value={adoptionReason} onChange={e=>{setAdoptionReason(e.target.value);setAdoptionDirty(true);}}/></label>{sheet.canAcknowledgeAdoption&&<Action disabled={disabled||!adoptionReason.trim()} onClick={()=>void send('/adoption-acknowledgement',{previewRevision:sheet.revision,reason:adoptionReason})}>主跟单确认当前资料预览</Action>}{sheet.canAdopt&&<Action disabled={disabled||!adoptionReason.trim()} onClick={()=>void send('/adoption',{previewRevision:sheet.revision,reason:adoptionReason})}>明确采用新规则</Action>}<p>采用不会重算已完成历史；实际起点已过时会如实显示原延期。</p></section>}
 {showOtherActions&&!readonly&&sheet.canDeliverInstruction&&resource.kind==='order'&&<details><summary>登记制单对外交付</summary><fieldset disabled={disabled}><div className="preparation-readiness-fields"><label>实际交付的已发布版本<input type="number" min="1" step="1" value={deliveryVersion} onChange={e=>{setDeliveryVersion(e.target.value);setDeliveryDirty(true);}}/></label><label>接收加工厂 / 联系人<input maxLength={200} value={deliveryRecipient} onChange={e=>{setDeliveryRecipient(e.target.value);setDeliveryDirty(true);}}/></label><label>实际交付时间（北京时间）<input type="datetime-local" value={deliveryAt} onChange={e=>{setDeliveryAt(e.target.value);setDeliveryDirty(true);}}/></label><label>交付说明<input maxLength={1000} value={deliveryNote} onChange={e=>{setDeliveryNote(e.target.value);setDeliveryDirty(true);}}/></label></div><Action disabled={!deliveryVersion||!deliveryRecipient.trim()||!deliveryAt||!deliveryNote.trim()} onClick={()=>void send('/instruction-deliveries',{instructionVersion:Number(deliveryVersion),recipient:deliveryRecipient,occurredAt:instant(deliveryAt),note:deliveryNote,evidenceIds:[]})}>保存交付记录</Action></fieldset></details>}
 <details><summary>原记录与历史版本（{shownHistory.length}条）</summary>{shownHistory.map(f=><article key={`${f.recordId}:${f.version}`}><strong>{preparationMaterialLabels[f.kind]} · 第{f.version}版 · {f.operatorName}</strong><p>{f.note} · {time(f.occurredAt)}{!f.valid&&` · ${f.invalidReasons.join('；')}`}</p>{f.evidenceIds.map((id,i)=><a key={id} href={urls.apiUrl(`digital-production/${base}/attachments/${id}`)} target="_blank" rel="noreferrer">原凭证{i+1} </a>)}</article>)}{showOtherActions&&sheet.instructionDeliveries.map(d=><p key={d.eventId}>制单版本{d.instructionVersion} · {d.recipient} · {time(d.occurredAt)} · {d.note}</p>)}</details>
 </details>{receipt&&<p role="status">{receipt}</p>}{error&&<p role="alert">{error}</p>}{pending&&<Action disabled={busy} onClick={()=>void feedback(async()=>{},true)}>使用原内容核对提交结果</Action>}</section>;
}
