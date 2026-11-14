import {useState} from 'react';
import type {SeriesPlanState} from '@dx-rework/contracts/digital-series-plan';
import {CockpitDate} from './cockpit-date.js';

/** These are the saved plan's own targets, never today's execution facts
 * relabelled as historical actual progress. Date targets end at local day end. */
export function SeriesPlanReading({state,stale=false,historicalOnly=false}:{state:SeriesPlanState;stale?:boolean;historicalOnly?:boolean}){
 const [revision,setRevision]=useState<number|null>(null);
 const versions=[...(state.current?[state.current]:[]),...state.history].filter((value,index,all)=>all.findIndex(row=>row.revision===value.revision)===index).sort((a,b)=>b.revision-a.revision);
 const selected=revision===null?state.current:versions.find(value=>value.revision===revision),historical=historicalOnly||Boolean(selected&&selected.revision!==state.current?.revision);
 if(!versions.length)return <p>本单尚未采用系列计划，实际业务进度仍可在上方查看。</p>;
 const dated=selected?.milestones.filter(row=>row.targetDate)??[],due=dated.filter(row=>row.targetDate!<state.serverToday),missing=(selected?.milestones.length??0)-dated.length;
 return <section className="series-plan-reading" aria-label="采用计划版本与日期依据">
  <label>阅读计划版本<select aria-label="阅读计划版本" value={revision===null?'current':String(revision)} onChange={event=>setRevision(event.target.value==='current'?null:Number(event.target.value))}>
   <option value="current">{historicalOnly?'原系列历史':stale?'上次读取的采用版':'当前采用'}{state.current?` · 第${state.current.revision}版`:' · 尚未采用'}</option>{versions.filter(row=>row.revision!==state.current?.revision).map(row=><option key={row.revision} value={row.revision}>历史第{row.revision}版</option>)}
  </select></label>
  {!selected?<p role="status">该版本已无法读取，请选择仍可读取的版本；未将当前版本数字套用到旧版。</p>:<div data-reading-plan-revision={selected.revision}>
   <h3>{historical?'历史':stale?'上次读取的采用':'当前已采用'}系列计划第{selected.revision}版 · {selected.route}路线</h3>
   <p>本版计划出货：{selected.plannedShippingDate}；采用时间：<CockpitDate value={selected.recordedAt} precision="instant"/>。</p>
   {stale&&<p role="status">以下保留上次读取的第{selected.revision}版；最新采用状态尚待读取，不将旧数字标为新版本。</p>}
   <p>本版保存{selected.milestones.length}项目标，其中{dated.length}项有目标日期；截至业务日期{state.serverToday}，{due.length}项目标日期已过当天结束{missing?`；另${missing}项目标日期未保存`:''}。</p>
   {dated.length>0&&missing===0&&<div className="cockpit-business-meter is-plan" role="progressbar" aria-label={`第${selected.revision}版已过目标日期的计划项`} aria-valuemin={0} aria-valuemax={dated.length} aria-valuenow={due.length}><i style={{width:`${due.length/dated.length*100}%`}}/></div>}
   <p>{historical?'本版未保存采用当时的完整实际完成快照，不能据今天的实绩重算历史完成比例。':'上方实际与计划进度按本次读取的适用业务要求计算。此处逐项查看本版保存的节点目标。'}</p>
   <div className="series-plan-scroll" tabIndex={0} role="region" aria-label={`第${selected.revision}版节点目标日期`}><table><thead><tr><th>节点 / 适用范围</th><th>本版目标日期</th><th>保留依据</th></tr></thead><tbody>{selected.milestones.map(row=><tr key={row.id}><th>{row.label}<small>{row.role} · {row.scopeRef==='whole'?'全单':row.scopeRef}</small></th><td>{row.targetDate??'本版未保存目标'}</td><td>{row.retainedFromRevision!==null?`保留第${row.retainedFromRevision}版目标`:'本版采用'}{row.frozenReason&&<small>{row.frozenReason}</small>}</td></tr>)}</tbody></table></div>
  </div>}
 </section>;
}
