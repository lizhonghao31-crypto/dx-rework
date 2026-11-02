import {useEffect,useRef,useState} from 'react';
import {StatusBadge,type Tone} from '@dx-rework/ui';
import {NodeMaterialsSchema,type NodeMaterials,type NodeMaterial,type JourneyNode,type OrderJourney} from '@dx-rework/contracts/digital-production-journey';
import {digitalRequest} from './digital-production-api.js';
import {sessionCacheVersion} from './auth-session.js';
import {CockpitRecordLink} from './cockpit-node-rows.js';
import {journeyTime} from './digital-journey-cockpit-model.js';
import {filterNodeMaterials,type useNodeMaterialsView} from './node-materials-view.js';
import './node-materials.css';
type View=ReturnType<typeof useNodeMaterialsView>;
const status:Record<NodeMaterial['state'],{label:string;tone:Tone}>={missing:{label:'尚缺',tone:'warning'},present:{label:'已有原记录',tone:'info'},partial:{label:'部分具备',tone:'warning'},effective:{label:'本项有效',tone:'success'},stale:{label:'旧版待复核',tone:'warning'},unknown:{label:'待核实',tone:'neutral'},not_applicable:{label:'无需此项',tone:'neutral'}};

export function NodeMaterialsPanel({order,node,control,busy=false}:{order:OrderJourney;node:JourneyNode;control:View;busy?:boolean}){
 const [result,setResult]=useState<{key:string;identity:string;order:OrderJourney;data:NodeMaterials}|null>(null),[error,setError]=useState<{key:string;identity:string;order:OrderJourney;message:string}|null>(null),[retry,setRetry]=useState(0);
 const panel=useRef<HTMLDetailsElement>(null),body=useRef<HTMLDivElement>(null),serial=useRef(0);
 const {view,key}=control;
 const shown=result?.key===key&&result.identity===control.identity&&result.order===order&&!busy?result.data:null;
 const failure=error?.key===key&&error.identity===control.identity&&error.order===order?error.message:'';
 const loading=view.open&&!busy&&!shown&&!failure;
 useEffect(()=>{const turn=++serial.current,identity=sessionCacheVersion(),abort=new AbortController();setResult(null);setError(null);
  if(view.open&&!busy){const query=new URLSearchParams({instanceId:node.instanceId,...(order.selectedRound?{round:String(order.selectedRound)}:{})});
   void digitalRequest<NodeMaterials>(`journeys/${order.id}/node-materials?${query}`,'GET',undefined,undefined,{signal:abort.signal}).then(data=>{
    if(turn!==serial.current||identity!==sessionCacheVersion())return;const parsed=NodeMaterialsSchema.safeParse(data);if(!parsed.success||parsed.data.journeyId!==order.id||parsed.data.instanceId!==node.instanceId)throw new Error('节点资料返回异常或范围已变化，请重新读取');setResult({key,identity:control.identity,order,data:parsed.data});
   }).catch(e=>{if(turn===serial.current&&e.name!=='AbortError')setError({key,identity:control.identity,order,message:e.message});});
  }return()=>{serial.current++;abort.abort();};
 },[order,node.instanceId,key,control.identity,view.open,retry,busy]);
 useEffect(()=>{
  if(!view.open||!shown||!body.current)return;const frame=requestAnimationFrame(()=>{if(body.current)body.current.scrollTop=view.scroll;});return()=>cancelAnimationFrame(frame);
 },[key,view.open,view.filter,Boolean(shown)]);
 useEffect(()=>{const restore=control.restore.current;if(!restore.pending||restore.key!==key||busy||view.open&&!shown)return;
  const root=panel.current?.closest('.journey-current-panel'),wanted=[...(root?.querySelectorAll<HTMLElement>('[data-material-focus]')??[])].find(e=>e.dataset.materialFocus===restore.focus);
  const target=wanted?.matches('a,button,input,select,summary,[tabindex]')?wanted:wanted?.querySelector<HTMLElement>('a,button,input,select,summary,[tabindex]');
  if(target){const frame=requestAnimationFrame(()=>target.focus({preventScroll:true}));restore.pending=false;return()=>cancelAnimationFrame(frame);}
 },[key,busy,shown,view.open]);
 const rows=filterNodeMaterials(shown?.rows??[],view.filter),pending=shown?.rows.filter(r=>r.applicability!=='not_applicable'&&!['effective','not_applicable'].includes(r.state)).length;
 return <details ref={panel} className="node-materials" open={view.open} onToggle={event=>{if(event.currentTarget.open!==view.open)control.update({open:event.currentTarget.open,focus:'summary'});}}>
  <summary data-material-focus="summary" aria-expanded={view.open}><strong>该节点所需材料一览</strong><span>{view.open?pending===undefined?'正在核对…':`待核对 ${pending} 项`:node.blockers.length?'有原流程前置待处理':'点击查看本节点资料'}</span></summary>
  {view.open&&<div className="node-materials-body">
   <div className="node-materials-controls" aria-label="材料筛选">{([['all','全部'],['pending','待处理'],['effective','已有效'],['mine','我的']] as const).map(([value,label])=><button type="button" data-material-focus={'filter-'+value} key={value} aria-pressed={view.filter===value} onClick={()=>control.update({filter:value,scroll:0,focus:'filter-'+value})}>{label}</button>)}<button type="button" onClick={()=>{setResult(null);setRetry(n=>n+1);}}>重新核对</button></div>
   {busy||loading?<p role="status">正在读取本节点的当前资料…</p>:failure?<p role="alert">读取失败：{failure}<button type="button" onClick={()=>setRetry(n=>n+1)}>重试</button></p>:shown?<>
    <p className="node-materials-notice">{shown.notice}</p>
    <div className="node-materials-list" ref={body} aria-label="本节点材料明细" onScroll={()=>{const scroll=Math.round(body.current?.scrollTop??0);if(scroll!==view.scroll)control.rememberScroll(scroll);}}>
     {rows.map(row=><article key={row.id} className="node-material-row" data-material-state={row.state}><div className="node-material-heading"><strong>{row.label}</strong><StatusBadge tone={status[row.state].tone}>{status[row.state].label}</StatusBadge></div><div className="node-material-scope">{row.scope} · {row.purpose==='input'?'输入依据':row.purpose==='output'?'本节点产出':'原资料参考'}{row.applicability==='optional'?' · 参考／按需':''}{row.versionLabel?` · ${row.versionLabel}`:''}</div><p>{row.reason}</p><dl><div><dt>负责</dt><dd>{row.role}{row.owner?.name?` · ${row.owner.name}`:row.owner?' · 姓名待核':''}</dd></div><div><dt>何时</dt><dd>{row.when==='later'?'待前置具备':row.when==='waiting_other'?'待相应岗位处理':'本节点办理时'} · {journeyTime(row.expectedAt,row.expectedPrecision,'未单列时限')}</dd></div></dl><div className="node-material-links">{row.records.map((record,i)=><span key={record.domain+record.id+i} data-material-focus={'record-'+row.id+'-'+i}><CockpitRecordLink record={record} context={control.context} onNavigate={()=>control.capture('record-'+row.id+'-'+i)}>打开原资料{row.records.length>1?` ${i+1}`:''}</CockpitRecordLink></span>)}</div></article>)}
     {!rows.length&&<p>当前筛选下没有可显示的项目；不据此推断整单资料齐全。</p>}
    </div>
   </>:<p>当前资料尚未读取，请重新核对。</p>}
  </div>}
 </details>;
}
