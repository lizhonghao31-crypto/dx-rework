import {OrderTimeRewashFields} from './order-time-rewash-fields.js';
import type {OrderTimeWashingReworkChanges} from '@dx-rework/contracts/order-time-washing-rework';
import {JOURNEY_STAGES} from '@dx-rework/contracts/digital-production-journey';
import {OrderTimeWashingFields} from './order-time-washing-fields.js';
import {rebaseWashingChanges} from './order-time-washing-rebase.js';
import {useEffect,useRef,useState} from 'react';
import {Button} from '@dx-rework/ui';
import {orderTimeGapText,OrderTimeCheckResultSchema,OrderTimeRequestReadSchema,type OrderTimeCheckResult,type OrderTimeRequestRead,type OrderTimeOperation,type OrderTimeWashingChanges} from '@dx-rework/contracts/order-time-requests';
import {OrderTimeRuleSchema,type OrderTimeRule} from '@dx-rework/contracts/order-time-plan';
import {digitalRequest,DigitalRequestError} from './digital-production-api.js';
import {createClientRequestId} from './client-request-id.js';
import {timeText,nodeTimeText,timeCalendars} from './order-time-settings-model.js';
import {confirmInApp,promptInApp} from './system-dialog.js';
import {useDigitalDetailNavigationGuard} from './use-digital-detail-navigation-guard.js';
import {NavigationIcon} from './navigation-icons.js';
import './order-time-request.css';

type Resource={kind:'source'|'order';id:string};
type Pending={path:string;body:unknown;key:string};
const equal=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const date=(value:string|null)=>value?new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'完成时间待确认';
const labels={needs_designer:'待设计师提交',pending:'待处理',returned:'已退回',withdrawn:'已撤回',applied:'已生效'};

export function OrderTimeRequestPage({requestId,resource,originalVersion,onClose}:{requestId?:string|undefined;resource?:Resource|undefined;originalVersion?:number|undefined;onClose():void}){
 const [request,setRequest]=useState<OrderTimeRequestRead|null>(null),[check,setCheck]=useState<OrderTimeCheckResult|null>(null),[original,setOriginal]=useState<OrderTimeCheckResult|null>(null),[overrides,setOverrides]=useState<Record<string,OrderTimeRule>>({}),[error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false),[previewing,setPreviewing]=useState(false),[uncertain,setUncertain]=useState(false);
 const [selectedStage,setSelectedStage]=useState<number|null>(null);
 const [conflict,setConflict]=useState('');
 const [rewashing,setRewashing]=useState<OrderTimeWashingReworkChanges>([]),[rewashInvalid,setRewashInvalid]=useState(false);
 const [washing,setWashing]=useState<OrderTimeWashingChanges>([]),[washingInvalid,setWashingInvalid]=useState(false),[washingReset,setWashingReset]=useState(0),[washingRebase,setWashingRebase]=useState(0);
 const [invalid,setInvalid]=useState<Record<string,boolean>>({}),[readRevision,setReadRevision]=useState(0);
 const emptyChanges=JSON.stringify({overrides:{},washing:[],rewashing:[]}),previewedChanges=useRef(emptyChanges);
 const live=useRef(true),generation=useRef(0),pending=useRef<Pending|null>(null),writing=useRef(false),navigation=useRef(false),currentChanges=useRef({overrides,washing,rewashing});currentChanges.current={overrides,washing,rewashing};
 const operation:OrderTimeOperation|undefined=request?.operation??(resource?{kind:'arrangement',resource}:undefined),requestBase=requestId?'order-time/requests/'+requestId:null;
 const ordinaryInvalid=Object.values(invalid).some(Boolean),dirty=Object.keys(overrides).length>0||washing.length>0||rewashing.length>0||washingInvalid||rewashInvalid||ordinaryInvalid,editable=originalVersion===undefined&&Boolean(check?.canApply&&(!request||request.state==='pending'));
 useDigitalDetailNavigationGuard(dirty||uncertain,busy,navigation,uncertain?'上次提交结果还没核对，是否离开本单？':'本单时效还没提交，是否离开？');
 useEffect(()=>{live.current=true;return()=>{live.current=false;generation.current++;};},[]);
 const load=async(acknowledgeConflict=false)=>{
  const turn=++generation.current;setError('');try{
   const next=requestBase?OrderTimeRequestReadSchema.parse(await digitalRequest(requestBase)):null;
   if(originalVersion!==undefined&&(next?.version!==originalVersion||next.requestId!==requestId)){
    if(live.current&&turn===generation.current){setRequest(null);setCheck(null);}
    throw Error('所选申请版本没有可打开的原件，未显示其他版本。');
   }
   const value=next?.check??OrderTimeCheckResultSchema.parse(await digitalRequest('order-time/check','POST',{operation:{kind:'arrangement',resource}}));
   if(!live.current||turn!==generation.current)return;
   const adoptedChanges=acknowledgeConflict?rebaseWashingChanges(original?.washing,currentChanges.current.washing,value.washing):null;
   previewedChanges.current=emptyChanges;setRequest(next);setCheck(value);setOriginal(before=>acknowledgeConflict?value:before??value);setReadRevision(before=>before+1);
   if(acknowledgeConflict){if(adoptedChanges)setWashing(adoptedChanges);setWashingRebase(value=>value+1);setPreviewing(dirty);setConflict('');setNotice('');}
  }catch(value){if(live.current&&turn===generation.current)setError(value instanceof Error?value.message:'本单时效读取失败');}
 };
 useEffect(()=>{void load();},[requestId,resource?.kind,resource?.id,originalVersion]);
 useEffect(()=>{
  const signature=JSON.stringify({overrides,washing,rewashing});
  if(!operation||!check||(!dirty&&previewedChanges.current===signature)||uncertain||washingInvalid||rewashInvalid||ordinaryInvalid){setPreviewing(false);return;}
  const turn=++generation.current;setPreviewing(true);
  const timer=window.setTimeout(()=>{void (requestBase?digitalRequest(requestBase+'/preview','POST',{overrides,washing,rewashing}):digitalRequest('order-time/preview','POST',{operation,overrides,washing,rewashing})).then(value=>{
   const next=requestBase?OrderTimeRequestReadSchema.parse(value):null,result=next?.check??OrderTimeCheckResultSchema.parse(value);
   if(!live.current||turn!==generation.current||signature!==JSON.stringify(currentChanges.current))return;
   previewedChanges.current=signature;if(next)setRequest(next);setCheck(result);setError('');
  }).catch(value=>{if(live.current&&turn===generation.current)setError(value instanceof Error?value.message:'演算未完成，本次输入保留');}).finally(()=>{if(live.current&&turn===generation.current)setPreviewing(false);});},200);
  return()=>{window.clearTimeout(timer);generation.current++;};
 },[overrides,washing,rewashing,rewashInvalid,washingInvalid,ordinaryInvalid,requestBase,operation?.kind,uncertain,readRevision]);
 const write=async(path:string,body:unknown)=>{
  if(originalVersion!==undefined||writing.current||conflict)return;writing.current=true;setBusy(true);setError('');setNotice('');pending.current??={path,body:structuredClone(body),key:createClientRequestId()};
  const command=pending.current;
  try{
   const response=await digitalRequest(command.path,'POST',command.body,command.key);
   if(command.path==='order-time/arrange'){
    const value=response as {saved?:boolean;check?:unknown};if(value.saved!==true)throw new Error('未收到完整生效回执，请核对上次提交');
    if(live.current){const saved=OrderTimeCheckResultSchema.parse(value.check);setCheck(saved);setOriginal(saved);setNotice('本单新安排已生效。');}
   }else{const value=OrderTimeRequestReadSchema.parse(response);if(live.current){setRequest(value);setCheck(value.check);setOriginal(value.check);setNotice(value.state==='applied'?'本单安排已生效，设计师无需再次确认。':'已保存本次处理。');}}
   pending.current=null;previewedChanges.current=emptyChanges;if(live.current){setUncertain(false);setOverrides({});setWashing([]);setWashingInvalid(false);setRewashing([]);setRewashInvalid(false);setWashingReset(value=>value+1);}window.dispatchEvent(new Event('dx-rework:todo-refresh'));
  }catch(value){
   if(live.current)setError(value instanceof Error?value.message:'本次提交未完成');
   if(value instanceof DigitalRequestError&&!value.resultUnknown){pending.current=null;if(live.current)setUncertain(false);
    if(value.code==='ORDER_TIME_STALE'){if(live.current)setConflict('原单已有变化，调整内容已保留；请重新读取并复核新基线，再提交本次草稿。');await load();}
   }else if(live.current)setUncertain(true);
  }finally{writing.current=false;if(live.current)setBusy(false);}
 };
 const submit=async()=>{
  if(!check||!editable||previewing||uncertain||error||conflict||washingInvalid||rewashInvalid||Object.values(invalid).some(Boolean)||check.feasibility==='unknown')return;
  const acceptLate=check.feasibility==='insufficient';
  if(acceptLate&&!await confirmInApp(orderTimeGapText(check)+'\n确认后直接生效，交期风险仍保留。',{title:'提交本单时效',confirmLabel:'确认',cancelLabel:'取消',className:'r5-time-late-confirmation'}))return;
  await write(requestBase?requestBase+'/apply':'order-time/arrange',{...(request?{expectedVersion:request.version}:{resource}),fingerprint:check.fingerprint,overrides,washing,rewashing,acceptLate});
 };
 const close=async(action:'return'|'withdraw')=>{
  if(!request||!requestBase||busy||uncertain)return;
  const reason=action==='return'?await promptInApp('退回原因','',{title:'退回设计师',confirmLabel:'退回',requiredMessage:'请填写退回原因'}):null;if(action==='return'&&!reason)return;
  await write(requestBase+'/'+action,{expectedVersion:request.version,...(reason?{reason}:{})});
 };
 const resubmit=async()=>{
  if(!request||!requestBase||!check)return;
  await write(requestBase+'/resubmit',{expectedVersion:request.version,operation:request.operation,fingerprint:check.fingerprint,reason:request.reason});
 };
 if(!check)return <section className="r5-time-request"><Button onClick={onClose}>返回</Button>{error?<><p role="alert">{error}</p><Button onClick={()=>void load()}>重新读取</Button></>:<p role="status">正在读取本单时效…</p>}</section>;
 const grouped=new Map<string,typeof check.rows[number]>();for(const row of check.rows){const previous=grouped.get(row.parameterKey);grouped.set(row.parameterKey,previous?{...row,begun:previous.begun&&row.begun,preserveBegun:Boolean(previous.preserveBegun||row.preserveBegun||previous.begun||row.begun)}:row);}const rows=[...grouped.values()].filter(row=>(!row.rule||row.rule.kind!=='event')&&!/^bulk_(factory|return)_washing/.test(row.parameterKey)),changes=rows.filter(row=>overrides[row.parameterKey]&&!equal(overrides[row.parameterKey],original?.rows.find(old=>old.parameterKey===row.parameterKey)?.rule));
 const stages=JOURNEY_STAGES.map((stage,index)=>({...stage,number:index+1})).filter(stage=>rows.some(row=>row.stage===stage.number));
 const activeStage=selectedStage!==null&&stages.some(stage=>stage.number===selectedStage)?selectedStage:stages[0]?.number;
 const visibleRows=rows.filter(row=>row.stage===activeStage);
 const disabled=busy||uncertain||!editable;
 return <section className="r5-time-request" aria-busy={busy}>
  <header><div><h1>本单时效调整 <span className={'r5-time-state is-'+(request?.state??'effective')}>{request?labels[request.state]:'当前安排'}</span>{originalVersion!==undefined&&<small>版本 {originalVersion} · 只读</small>}</h1><p>{check.styleNo}{request?.requestedBy.name&&<> · 申请人 {request.requestedBy.name}</>}</p><p className="r5-time-subtitle">仅调整本单，不修改公司设置。</p></div><div><Button type="button" disabled={busy||uncertain} onClick={()=>void load()}>刷新</Button><Button type="button" disabled={busy} onClick={onClose}>返回</Button></div></header>
  <div className="r5-time-metrics"><div><span className="r5-time-metric-heading"><NavigationIcon name="ClipboardCheck"/>客户交期</span><strong>{check.customerDates.length===1?check.customerDates[0]!.date??'尚未确定':check.customerDates.map(row=>row.po+' '+(row.date??'尚未确定')).join('／')}</strong></div><div><span className="r5-time-metric-heading"><NavigationIcon name="Clock"/>可用时间</span><strong>{timeText(check.availableMinutes===null?null:Math.max(0,check.availableMinutes))}</strong></div><div><span className="r5-time-metric-heading"><NavigationIcon name="FileText"/>原方案</span><strong>{timeText(original?.requiredMinutes??null)}</strong></div><div><span className="r5-time-metric-heading"><NavigationIcon name="Clock"/>本次需要</span><strong>{previewing?'正在演算…':timeText(check.requiredMinutes)}</strong></div></div>
  {check.feasibility==='insufficient'?<p className="r5-time-risk" role="status">{orderTimeGapText(check).replace('，是否继续？','')}</p>:check.feasibility==='unknown'?<p className="r5-time-risk">{check.coverage.join('；')||'必要时间或路线还没确定'}</p>:check.feasibility==='not_applicable'?<p>未填写选填的样板完成日期，不作日期比较；仍按已采用的节点时效办理。</p>:<p className="r5-time-sufficient">{check.availableMinutes===check.requiredMinutes?'时间刚好，没有余量':'按当前安排可按期完成'}</p>}
  {error&&<p role="alert">{error}</p>}{conflict&&<div role="alert"><p>{conflict}</p><Button disabled={busy||uncertain} onClick={()=>void load(true)}>重新读取并复核新基线</Button></div>}{notice&&<p role="status">{notice}</p>}{request?.returnReason&&<p>退回原因：{request.returnReason}</p>}
  {uncertain&&<p role="status">上次提交结果待核对，原内容已保留。<Button disabled={busy} onClick={()=>pending.current&&void write(pending.current.path,pending.current.body)}>核对上次提交结果</Button></p>}
  {check.washing&&<OrderTimeWashingFields key={washingReset} rows={check.washing} rebaseRevision={washingRebase} plan={check.plan} disabled={disabled} onChange={value=>{if(!equal(value,currentChanges.current.washing))setNotice('');setWashing(value);setError('');}} onInvalid={bad=>{if(bad)setNotice('');setWashingInvalid(bad);}}/>}
  {washingInvalid&&<p role="alert">请补齐洗水用时和办理人员。</p>}
  {editable&&check.rewashing&&<OrderTimeRewashFields key={`rewash:${washingReset}`} rows={check.rewashing} value={rewashing} disabled={disabled} onChange={next=>{setRewashing(next);setNotice('');setError('');}} onInvalid={setRewashInvalid}/>}
  {rewashInvalid&&<p role="alert">请填写有效的本轮返洗计划数量。</p>}
  <div className="r5-time-layout"><div className="r5-time-table"><nav className="r5-time-stage-tabs" aria-label="本单时效阶段">{stages.map(stage=><button type="button" key={stage.key} aria-pressed={activeStage===stage.number} onClick={()=>setSelectedStage(stage.number)}>{stage.label}</button>)}</nav><table><thead><tr><th>适用节点</th><th>原用时</th><th>本次用时</th><th>哪些天计时</th><th>提醒</th></tr></thead><tbody>{visibleRows.map(row=>{
   const rule=overrides[row.parameterKey]??row.rule,baseline=original?.rows.find(old=>old.parameterKey===row.parameterKey)?.rule??row.rule;
   return <tr key={row.parameterKey}><th>{row.label}{row.begun?<small>已开始，保留原责任窗口</small>:row.preserveBegun?<small>已开始部分保留原时效</small>:null}</th><td>{baseline?nodeTimeText(baseline,row.parameterKey):'还没设置'}</td>{rule?<RuleFields key={row.parameterKey} label={row.label} value={rule} disabled={disabled||row.begun} onInvalid={bad=>{if(bad)setNotice('');setInvalid(before=>before[row.parameterKey]===bad?before:{...before,[row.parameterKey]:bad});}} onChange={value=>{setNotice('');setOverrides(before=>({...before,[row.parameterKey]:value}));setError('');}}/>:<td colSpan={3}>还没设置</td>}</tr>;
  })}</tbody></table></div><aside className="r5-time-changes"><h2>变动明细</h2>{check.factoryCommitments?.map(row=><p key={row.lineId}><span>{row.label} 工厂交货 {row.date}</span><strong>计划回货 {row.plannedReceipt?date(row.plannedReceipt):'待核实'}{row.status==='insufficient'&&' · 超出承诺'}</strong></p>)}{changes.map(row=><p key={row.parameterKey}><span>{row.label}</span><strong>{row.rule?nodeTimeText(original?.rows.find(old=>old.parameterKey===row.parameterKey)?.rule??row.rule):'未设置'} → {nodeTimeText(overrides[row.parameterKey]!)}</strong></p>)}<p><span>原方案</span><strong>{timeText(original?.requiredMinutes??null)} → 本次{timeText(check.requiredMinutes)}</strong></p><p><span>{check.forecastQuality==='lower_bound'?'完成下界':'按当前安排'}</span><strong>{date(check.expectedEnd)}</strong></p></aside></div>
  <footer className="r5-time-actions"><div>{originalVersion===undefined&&request?.canWithdraw&&<Button disabled={busy||uncertain} onClick={()=>void close('withdraw')}>撤回申请</Button>}{editable&&request&&<Button disabled={busy||uncertain} onClick={()=>void close('return')}>退回设计师</Button>}</div><div>{editable&&<><Button disabled={disabled} onClick={()=>{setNotice('');setOverrides(Object.fromEntries(rows.filter(row=>!row.begun&&row.originalRule).map(row=>[row.parameterKey,row.originalRule!])));}}>恢复标准</Button><Button variant="primary" disabled={disabled||previewing||Boolean(error)||Boolean(conflict)||washingInvalid||rewashInvalid||Object.values(invalid).some(Boolean)||check.feasibility==='unknown'} onClick={()=>void submit()}>提交</Button></>}{originalVersion===undefined&&request&&check.canRequest&&['needs_designer','returned','withdrawn'].includes(request.state)&&<Button variant="primary" disabled={busy||uncertain} onClick={()=>void resubmit()}>提交时效调整申请</Button>}</div></footer>
 </section>;
}

/** One row owns its text until blur, so decimal entry and server previews do
 * not rewrite an unfinished number. Values still pass the common rule schema. */
function RuleFields({label,value,disabled,onChange,onInvalid}:{label:string;value:OrderTimeRule;disabled:boolean;onChange(value:OrderTimeRule):void;onInvalid(value:boolean):void}){
 const units={minutes:1,hours:60,days:1440},[unit,setUnit]=useState<'minutes'|'hours'|'days'>(value.minutes&&value.minutes%1440===0?'days':value.minutes&&value.minutes%60===0?'hours':'minutes'),focused=useRef(false);
 const [raw,setRaw]=useState(value.kind==='offset'?String(value.days??''):value.minutes===null?'':String(value.minutes/units[unit]));
 const [bad,setBad]=useState(false);
 useEffect(()=>{if(!focused.current){setRaw(value.kind==='offset'?String(value.days??''):value.minutes===null?'':String(value.minutes/units[unit]));setBad(false);onInvalid(false);}},[value,unit]);
 const write=(next:unknown,text=raw)=>{const number=text.trim()===''?null:Number(text),base=OrderTimeRuleSchema.safeParse(next),candidate=base.success?(base.data.kind==='offset'?{...base.data,days:number}:{...base.data,minutes:number===null?null:number*units[unit]}):next;const result=OrderTimeRuleSchema.safeParse(candidate);setBad(!result.success);onInvalid(!result.success);if(result.success)onChange(result.data);};
 if(['event','date'].includes(value.kind))return <><td>按实际业务日期</td><td>—</td><td>—</td></>;
 return <><td><div className="r5-time-value"><input aria-label={label+'本次用时'} aria-invalid={bad} inputMode="decimal" value={raw} disabled={disabled} onFocus={()=>{focused.current=true;}} onBlur={()=>{focused.current=false;}} onChange={event=>{setRaw(event.target.value);write(value,event.target.value);}}/>{value.kind==='offset'?<span>天</span>:<select aria-label={label+'用时单位'} value={unit} disabled={disabled} onChange={event=>{if(bad)return;setUnit(event.target.value as typeof unit);}}><option value="minutes">分钟</option><option value="hours">小时</option><option value="days">天</option></select>}</div>{bad&&<small role="alert">请填写有效用时</small>}</td>
  <td>{value.kind==='included'?'跟随所属工序':value.kind==='offset'?'按客户交期':<select aria-label={label+'哪些天计时'} disabled={disabled} value={value.calendar??''} onChange={event=>write({...value,calendar:event.target.value||null})}><option value="">还没设置</option>{Object.entries(timeCalendars).map(([key,text])=><option key={key} value={key}>{text}</option>)}</select>}</td>
  <td><label className="r5-time-reminder"><input type="checkbox" role="switch" aria-label={label+'提醒'} disabled={disabled} checked={value.reminder.enabled} onChange={event=>write({...value,reminder:{...value.reminder,enabled:event.target.checked}})}/><span>{value.reminder.enabled?'开启':'关闭'}</span></label>{value.reminder.enabled&&value.kind!=='offset'&&<label className="r5-time-percent"><input type="number" aria-label={label+'提醒比例'} min={1} max={99} disabled={disabled} value={value.reminder.percent} onChange={event=>write({...value,reminder:{...value.reminder,percent:Number(event.target.value)}})}/>%</label>}</td></>;
}
