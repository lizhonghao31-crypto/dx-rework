import {useEffect,useRef,useState} from 'react';
import {StatusBadge,type Tone} from '@dx-rework/ui';
import {NodeMaterialsSchema,type NodeMaterials,type NodeMaterial,type JourneyNode,type OrderJourney} from '@dx-rework/contracts/digital-production-journey';
import {digitalRequest,DigitalRequestError} from './digital-production-api.js';
import {sessionCacheVersion} from './auth-session.js';
import {CockpitRecordLink} from './cockpit-node-rows.js';
import {journeyTime} from './digital-journey-cockpit-model.js';
import {filterNodeMaterials,type useNodeMaterialsView} from './node-materials-view.js';
import {trapCockpitDialogFocus} from './cockpit-dialog-focus.js';
import './node-materials.css';
type View=ReturnType<typeof useNodeMaterialsView>;
const status:Record<NodeMaterial['state'],{label:string;tone:Tone}>={missing:{label:'尚缺',tone:'warning'},present:{label:'已有原记录',tone:'info'},partial:{label:'部分具备',tone:'warning'},effective:{label:'本项有效',tone:'success'},stale:{label:'旧版待复核',tone:'warning'},unknown:{label:'待核实',tone:'neutral'},not_applicable:{label:'无需此项',tone:'neutral'}};
const pending=(row:NodeMaterial)=>row.applicability!=='not_applicable'&&!['effective','not_applicable'].includes(row.state);

export function NodeMaterialsPanel({order,node,control,busy=false}:{order:OrderJourney;node:JourneyNode;control:View;busy?:boolean}){
 const [result,setResult]=useState<{key:string;identity:string;order:OrderJourney;data:NodeMaterials}|null>(null),[error,setError]=useState<{key:string;identity:string;order:OrderJourney;message:string}|null>(null),[retry,setRetry]=useState(0),[loading,setLoading]=useState(false);
 const panel=useRef<HTMLDivElement>(null),trigger=useRef<HTMLButtonElement>(null),dialog=useRef<HTMLDialogElement>(null),body=useRef<HTMLDivElement>(null),serial=useRef(0),closing=useRef(false);
 const {view,key}=control,shown=result?.key===key&&result.identity===control.identity&&result.order===order&&!busy?result.data:null;
 const failure=error?.key===key&&error.identity===control.identity&&error.order===order?error.message:'';
 const close=()=>{closing.current=true;setResult(null);setError(null);control.update({open:false,focus:'summary'});};
 useEffect(()=>{
  const turn=++serial.current,identity=sessionCacheVersion(),abort=new AbortController();
  setError(null);
  if(!view.open||busy||!control.identity){setResult(null);setLoading(false);return()=>{++serial.current;abort.abort();};}
  setResult(previous=>previous?.key===key&&previous.identity===control.identity&&previous.order===order?previous:null);setLoading(true);
  const query=new URLSearchParams({instanceId:node.instanceId,...(control.context.round?{round:String(control.context.round)}:{})});
  const live=()=>turn===serial.current&&identity===sessionCacheVersion();
  void digitalRequest<NodeMaterials>('journeys/'+order.id+'/node-materials?'+query,'GET',undefined,undefined,{signal:abort.signal}).then(data=>{
   if(!live())return;const parsed=NodeMaterialsSchema.safeParse(data);
   if(!parsed.success||parsed.data.journeyId!==order.id||parsed.data.instanceId!==node.instanceId||control.context.round!==undefined&&parsed.data.round!==control.context.round)throw new Error('节点资料返回异常或范围已变化，请重新读取');
   setResult({key,identity:control.identity,order,data:parsed.data});
  }).catch(e=>{if(!live()||e.name==='AbortError')return;if(e instanceof DigitalRequestError&&e.status!==null&&[401,403,404].includes(e.status))setResult(null);setError({key,identity:control.identity,order,message:e.message});
  }).finally(()=>{if(live())setLoading(false);});
  return()=>{++serial.current;abort.abort();};
 },[order,node.instanceId,key,control.identity,control.context.round,view.open,retry,busy]);
 useEffect(()=>{
  if(!view.open||!dialog.current)return;const element=dialog.current,overflow=document.body.style.overflow;closing.current=false;element.showModal();document.body.style.overflow='hidden';
  return()=>{closing.current=true;element.close();document.body.style.overflow=overflow;if(trigger.current?.isConnected)trigger.current.focus({preventScroll:true});};
 },[view.open,key]);
 useEffect(()=>{
  if(!view.open||!shown||!body.current)return;const frame=requestAnimationFrame(()=>{if(body.current)body.current.scrollTop=view.scroll;});return()=>cancelAnimationFrame(frame);
 },[key,view.open,view.filter,Boolean(shown)]);
 useEffect(()=>{
  const restore=control.restore.current;if(!restore.pending||restore.key!==key||busy||view.open&&!shown)return;
  const root=panel.current?.closest('.journey-current-panel'),wanted=[...(root?.querySelectorAll<HTMLElement>('[data-material-focus]')??[])].find(e=>e.dataset.materialFocus===restore.focus);
  const target=wanted?.matches('a,button,input,select,summary,[tabindex]')?wanted:wanted?.querySelector<HTMLElement>('a,button,input,select,summary,[tabindex]');
  if(target){const frame=requestAnimationFrame(()=>target.focus({preventScroll:true}));restore.pending=false;return()=>cancelAnimationFrame(frame);}
 },[key,busy,shown,view.open]);
 const rows=filterNodeMaterials(shown?.rows??[],view.filter),waiting=rows.filter(pending),available=rows.filter(row=>!pending(row));
 const rowView=(row:NodeMaterial)=><article key={row.id} className="node-material-row" data-material-state={row.state}>
  <div className="node-material-heading"><strong>{row.label}</strong><StatusBadge tone={status[row.state].tone}>{status[row.state].label}</StatusBadge></div>
  <div className="node-material-scope">{row.scope||'适用范围待核'} · {row.purpose==='input'?'输入依据':row.purpose==='output'?'本节点产出':'原资料参考'}{row.applicability==='optional'?' · 参考／按需':''}{row.versionLabel?' · '+row.versionLabel:''}</div>
  <section className="node-material-rule" aria-label="适用规则与负责岗位"><p>{row.reason}</p><small>{row.effect==='original_gate'?'原流程前置':row.effect==='reminder'?'原流程提醒':'办理参考'}</small><dl><div><dt>负责</dt><dd>{row.role||'负责岗位待核'}{row.owner?.name?' · '+row.owner.name:row.owner?' · 姓名待核':''}</dd></div><div><dt>何时</dt><dd>{row.when==='later'?'待前置具备':row.when==='waiting_other'?'待相应岗位处理':'本节点办理时'} · {journeyTime(row.expectedAt,row.expectedPrecision,'未单列时限')}</dd></div></dl></section>
  <div className="node-material-links" aria-label="原资料与记录">{row.records.map((record,i)=><span key={record.domain+record.id+i} data-material-focus={'record-'+row.id+'-'+i}><CockpitRecordLink record={record} context={control.context} onNavigate={()=>control.capture('record-'+row.id+'-'+i)}>打开原资料{row.records.length>1?' '+(i+1):''}</CockpitRecordLink></span>)}{!row.records.length&&<small>本项尚无可打开的原记录。</small>}</div>
 </article>;
 return <div ref={panel} className="node-materials" data-material-revision={shown?.revision}>
  <button ref={trigger} type="button" className="node-materials-trigger" data-material-focus="summary" aria-expanded={view.open} disabled={busy} onClick={()=>{++serial.current;setResult(null);setError(null);control.update({open:true,focus:'summary'});}}><strong>该节点所需材料一览</strong></button>
  {view.open&&<dialog ref={dialog} className="node-materials-dialog" aria-label="该节点所需材料一览" onKeyDown={trapCockpitDialogFocus} onCancel={event=>{event.preventDefault();close();}} onClose={()=>{if(!closing.current)close();}}>
   <header><div><h2>{node.label} · 所需材料</h2><p>{order.designStyleNo} · {node.subject||'本节点范围'}</p></div><button type="button" aria-label="关闭节点材料" onClick={close}>关闭</button></header>
   <div className="node-materials-controls" aria-label="材料筛选">{([['all','全部'],['pending','待处理'],['effective','已有效'],['mine','我的']] as const).map(([value,label])=><button type="button" data-material-focus={'filter-'+value} key={value} aria-pressed={view.filter===value} onClick={()=>control.update({filter:value,scroll:0,focus:'filter-'+value})}>{label}</button>)}<button type="button" disabled={busy||loading} onClick={()=>setRetry(value=>value+1)}>重新核对</button></div>
   {busy?<p role="status">本单正在读取或当前资料尚未核准；可关闭后刷新本单。</p>:<>{loading&&<p role="status">{shown?'正在重新核对；以下保留上次资料和原数据时点。':'正在读取本节点的当前资料…'}</p>}{failure&&<p role="alert">读取失败：{failure}。{shown?'以下仍为上次已读资料。':''}<button type="button" disabled={loading} onClick={()=>setRetry(value=>value+1)}>重试</button></p>}{shown?<><p className="node-materials-notice">{shown.notice}</p><p>资料时点：{journeyTime(shown.asOf)} · 待核对{shown.rows.filter(pending).length}项</p><div className="node-materials-list" ref={body} aria-label="本节点材料明细" onScroll={()=>{const scroll=Math.round(body.current?.scrollTop??0);if(scroll!==view.scroll)control.rememberScroll(scroll);}}>
    {waiting.length>0&&<section aria-label="待核对材料"><h3>待核对材料</h3>{waiting.map(rowView)}</section>}
    {available.length>0&&<section aria-label="已有材料与其他原记录"><h3>已有材料与其他原记录</h3>{available.map(rowView)}</section>}
    {!rows.length&&<p>当前筛选下没有可显示的项目；不据此推断整单资料齐全。</p>}
   </div></>:!loading&&!failure&&<p>当前资料尚未读取，请重新核对。</p>}</>}
  </dialog>}
 </div>;
}
