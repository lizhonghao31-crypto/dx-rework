import {useCallback,useEffect,useRef,useState} from 'react';
import {ORDER_TIME_NODES,OrderTimeConfigurationSchema,type OrderTimeSettingsHistory,type OrderTimeSettingsRead} from '@dx-rework/contracts/order-time-settings';
import type {OrderTimeRule} from '@dx-rework/contracts/order-time-plan';
import {JOURNEY_STAGES} from '@dx-rework/contracts/digital-production-journey';
import {digitalRequest,DigitalRequestError} from './digital-production-api.js';
import {createClientRequestId} from './client-request-id.js';
import {OrderTimeNodeFields} from './order-time-node-fields.js';
import {initialTimeRoute,OrderTimeRouteFields} from './order-time-route-fields.js';
import {nodeCalendarText,nodeTimeText,setNodeTime,timeText,historyTimeText} from './order-time-settings-model.js';
import {useOrderTimeCalculation} from './use-order-time-calculation.js';
import {useDigitalDetailNavigationGuard} from './use-digital-detail-navigation-guard.js';

type Pending={action:'save'|'use'|'remove';body:unknown;key:string};
const equal=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
export function OrderTimeStandardEditor({initial,readOnly,onAuthorityChanged,onSaved}:{initial:OrderTimeSettingsRead;readOnly:boolean;onAuthorityChanged():void;onSaved(value:OrderTimeSettingsRead):void}){
 const [state,setState]=useState(initial),[values,setValues]=useState(()=>structuredClone(initial.current)),[stage,setStage]=useState(2),[selected,setSelected]=useState<string|null>('development_pattern');
 const [history,setHistory]=useState<OrderTimeSettingsHistory|null>(null),[error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false),[uncertain,setUncertain]=useState(false),[conflict,setConflict]=useState(false),[route,setRoute]=useState(initialTimeRoute);
 const [baseline,setBaseline]=useState(()=>structuredClone(initial.current)),[editRevision,setEditRevision]=useState(0);
 const pending=useRef<Pending|null>(null),active=useRef(false),live=useRef(true),navigation=useRef(false),historyGeneration=useRef(0);
 const [editing,setEditing]=useState<{dirty:boolean;preview:OrderTimeRule|null}>({dirty:false,preview:null});
 const editingChange=useCallback((next:{dirty:boolean;preview:OrderTimeRule|null})=>setEditing(next),[]);
 const dirty=!equal(values,baseline)||editing.dirty,disabled=readOnly||busy||uncertain;
 const selectNode=(key:string|null,nextStage=stage)=>{if(editing.dirty){setNotice('请先确定或取消当前节点的修改。');return;}setSelected(key);setStage(nextStage);setNotice('');};
 useDigitalDetailNavigationGuard(dirty,busy||uncertain,navigation,'本次修改还没保存，是否离开？');
 useEffect(()=>{live.current=true;return()=>{live.current=false;historyGeneration.current++;};},[]);
 // A settings summary is explicitly the selected applicable route, not the sum
 // of mutually exclusive crafts. The reference date only anchors its calendar.
 const previewValues=selected&&editing.dirty&&editing.preview?setNodeTime(values,selected,editing.preview):values;
 const calculation=useOrderTimeCalculation(editing.dirty&&!editing.preview?null:{values:previewValues,startAt:state.referenceTime,lines:[{id:'参考路线',customerDate:null}],...route});
 const summary=calculation.result?.lines[0],rows=ORDER_TIME_NODES.filter(n=>n.stage===stage),meta=ORDER_TIME_NODES.find(n=>n.key===selected),value=selected?values.nodes[selected]:null;
 const issues=OrderTimeConfigurationSchema.safeParse(values),fieldErrors=issues.success?{}:Object.fromEntries(issues.error.issues.map(i=>[String(i.path[1]??''),i.message]));
 const authority=(reason:unknown)=>{if(reason instanceof DigitalRequestError&&[401,403].includes(reason.status??0))onAuthorityChanged();};
 const accept=(next:OrderTimeSettingsRead)=>{setState(next);onSaved(next);setValues(structuredClone(next.current));setBaseline(structuredClone(next.current));setConflict(false);setEditRevision(v=>v+1);};
 const historyRead=async(page=1)=>{const generation=++historyGeneration.current,next=await digitalRequest<OrderTimeSettingsHistory>('order-time-settings/history?page='+page);if(live.current&&generation===historyGeneration.current)setHistory(next);};
 useEffect(()=>{void historyRead().catch(reason=>{if(live.current)setError(reason.message);});},[]);
 const refresh=async(preserve=dirty)=>{
  if(active.current||uncertain)return;active.current=true;setBusy(true);setError('');try{const next=await digitalRequest<OrderTimeSettingsRead>('order-time-settings');if(!live.current)return;
   if(preserve){setState(next);setConflict(next.version!==state.version);}else accept(next);await historyRead(history?.page??1);
  }catch(reason){authority(reason);if(live.current)setError((reason as Error).message);}finally{active.current=false;if(live.current)setBusy(false);}
 };
 const write=async(action:Pending['action'],body:unknown)=>{
  if(readOnly||active.current)return;active.current=true;setBusy(true);setError('');setNotice('');
  const operation=pending.current??{action,body:structuredClone(body),key:createClientRequestId()};pending.current=operation;
  try{
   const result=await digitalRequest<{record?:{id:string};existingOrdersChanged?:number;deleted?:boolean}>('order-time-settings/'+operation.action,'POST',operation.body,operation.key);
   if(operation.action==='remove'?!result.deleted:!result.record?.id||result.existingOrdersChanged!==0)throw new DigitalRequestError('保存回执不完整，请核对上次操作',null);
   pending.current=null;setUncertain(false);setNotice(operation.action==='remove'?'已从历史设置删除。':'已保存并使用，只用于新订单。');
   if(operation.action!=='remove'){setBaseline(structuredClone(values));setConflict(false);}
   try{const next=await digitalRequest<OrderTimeSettingsRead>('order-time-settings');if(live.current){if(operation.action==='remove'){setState(next);}else accept(next);}await historyRead(history?.page??1);}
   catch(reason){authority(reason);if(live.current)setError('操作已成功，刷新失败。请刷新，不要重复保存。');}
  }catch(reason){authority(reason);if(live.current)setError((reason as Error).message);
   if(reason instanceof DigitalRequestError&&reason.resultUnknown)setUncertain(true);
   else{pending.current=null;setUncertain(false);if(reason instanceof DigitalRequestError&&reason.status===409){setConflict(true);try{const next=await digitalRequest<OrderTimeSettingsRead>('order-time-settings');if(live.current)setState(next);}catch{/* The user's original input and basis survive. */}}}
  }finally{active.current=false;if(live.current)setBusy(false);}
 };
 const merge=()=>{const next=structuredClone(state.current);for(const [key,rule]of Object.entries(values.nodes))if(!equal(rule,baseline.nodes[key]))next.nodes[key]=rule;if(values.stageBufferMinutes!==baseline.stageBufferMinutes)next.stageBufferMinutes=values.stageBufferMinutes;setValues(next);setBaseline(structuredClone(state.current));setConflict(false);setEditRevision(v=>v+1);setNotice('已保留本次修改，请核对后保存。');};
 const change=(key:string,rule:OrderTimeRule)=>setValues(before=>setNodeTime(before,key,rule));
 return <div className="r5-standard-editor">
  <div className="r5-current-settings"><span>当前使用：<strong>{state.record?'第'+state.record.version+'套设置':'尚未保存'}</strong></span><button className="r5-link" disabled={busy||uncertain} onClick={()=>void refresh()}>刷新</button><a href="#r5-settings-history">历史设置</a></div>
  {error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
  {uncertain&&<div role="status">上次操作结果待核对，填写内容已保留。<button className="r5-button" disabled={busy} onClick={()=>void write(pending.current!.action,pending.current!.body)}>核对上次操作结果</button></div>}
  {conflict&&<div role="alert">设置已被其他人修改，本次填写已保留。<button className="r5-button" disabled={disabled} onClick={merge}>核对新设置并保留修改</button></div>}
  <div className="r5-stage-heading"><nav aria-label="时效设置阶段">{JOURNEY_STAGES.map((s,i)=><button type="button" key={s.key} className={stage===i+1?'is-current':''} aria-pressed={stage===i+1} onClick={()=>selectNode(null,i+1)}>{s.label}</button>)}</nav><div className="r5-span-summary"><span>本阶段需要多久 <strong>{timeText(summary?.stages.find(s=>s.stage===stage)?.spanMinutes??null)}</strong></span><span>整单需要多久 <strong>{timeText(summary?.totalSpanMinutes??null)}</strong></span></div></div>
  <OrderTimeRouteFields value={route} onChange={setRoute}/>
  {calculation.error&&<p role="alert">{calculation.error}</p>}
  <div className="r5-settings-grid"><section className="r5-node-list" aria-label="本阶段时效"><div className="r5-table-scroll"><table><thead><tr><th>节点</th><th>所需时间</th><th>哪些天计时</th><th>提醒</th></tr></thead><tbody>{rows.map(node=>{const rule=values.nodes[node.key]!;return <tr key={node.key} className={selected===node.key?'is-selected':''}><th><button type="button" className="r5-node-name" onClick={()=>selectNode(node.key)}>{node.label}</button>{fieldErrors[node.key]&&<small role="alert">{fieldErrors[node.key]}</small>}</th><td>{nodeTimeText(rule,node.key)}</td><td>{nodeCalendarText(rule,node.key)}</td><td>{['event','date'].includes(rule.kind)?'—':<label className="r5-reminder"><input type="checkbox" role="switch" className="r5-switch" aria-label={node.label+'提醒'} disabled={disabled||editing.dirty} checked={rule.reminder.enabled} onChange={e=>{change(node.key,{...rule,reminder:{...rule.reminder,enabled:e.target.checked}});setEditRevision(v=>v+1);}}/><span>{rule.reminder.enabled?'开启':'关闭'}</span></label>}</td></tr>;})}</tbody></table></div></section>
   <aside className="r5-settings-side">{meta&&value&&<OrderTimeNodeFields key={meta.key+':'+editRevision} nodeKey={meta.key} label={meta.label} value={value} current={state.current.nodes[meta.key]!} readOnly={disabled} onEditingChange={editingChange} onCancel={()=>{setSelected(null);setNotice('');}} onConfirm={rule=>{change(meta.key,rule);setSelected(null);setNotice('');}}/>}
    <section className="r5-settings-history" id="r5-settings-history"><h2>历史设置</h2>{history?history.items.length?<>{history.items.map(row=><div className="r5-history-row" key={row.id}><span>{historyTimeText(row)}{row.partial&&<small>缺少{row.missing.join('、')}</small>}</span><button className="r5-button r5-success" disabled={disabled||editing.dirty||row.partial||!state.enabled||row.kind==='order_time'&&row.id===state.record?.id} onClick={()=>void write('use',{expectedVersion:state.version,id:row.id,kind:row.kind})}>使用这版</button><button className="r5-button r5-danger" disabled={disabled||editing.dirty||!state.enabled||row.kind==='order_time'&&row.id===state.record?.id} onClick={()=>void write('remove',{expectedVersion:state.version,id:row.id,kind:row.kind})}>删除</button></div>)}<div className="r5-pagination"><button disabled={busy||uncertain||history.page===1} onClick={()=>void historyRead(history.page-1).catch(e=>setError(e.message))}>上一页</button><span>第{history.page}页 · 共{history.totalCount}条</span><button disabled={busy||uncertain||history.page*15>=history.totalCount} onClick={()=>void historyRead(history.page+1).catch(e=>setError(e.message))}>下一页</button></div></>:<p>还没有历史设置。</p>:<p>正在读取历史设置…</p>}</section>
   </aside></div>
  <div className="r5-buffer-field"><label>每次阶段交接额外预留<input type="number" min={0} max={8760} step="any" aria-label="阶段间额外预留小时" value={values.stageBufferMinutes/60} disabled={disabled} onChange={e=>setValues({...values,stageBufferMinutes:Number(e.target.value)*60})}/>小时</label>{!issues.success&&issues.error.issues.some(issue=>issue.path[0]==='stageBufferMinutes')&&<small role="alert">请填写0至8760小时，至少精确到整分钟。</small>}</div>
  <footer className="r5-save-footer"><span>只用于新订单</span><div><button className="r5-button" disabled={disabled} onClick={()=>{setValues(structuredClone(state.current));setBaseline(structuredClone(state.current));setConflict(false);setSelected(null);setError('');setNotice('');}}>放弃修改</button><button className="r5-button r5-primary" disabled={disabled||editing.dirty||!state.enabled||conflict||!issues.success||(!dirty&&state.record!==null)} onClick={()=>void write('save',{expectedVersion:state.version,values,sourceId:null})}>{busy?'正在保存…':'保存并使用'}</button></div></footer>
 </div>;
}
