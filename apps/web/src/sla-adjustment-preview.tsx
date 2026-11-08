import {Button} from '@dx-rework/ui';
import {createContext,useContext,useEffect,useRef,useState,type Dispatch,type SetStateAction} from 'react';
import {createPortal} from 'react-dom';
import {JOURNEY_STAGES} from '@dx-rework/contracts/digital-production-journey';
import type {CalculationGraph,SlaCalculationResult} from '@dx-rework/contracts/sla-calculation';
import {CockpitHomeDialog} from './cockpit-home-dialog.js';
import {type settingsStandardTimes,calculationSpanLabel} from './sla-calculation-preview-model.js';
import {readableSlaMinutes} from './sla-settings-draft.js';
import {slaTargetLabel} from './journey-sla-details.js';

export type SlaAdjustmentComparison={
 current:ReturnType<typeof settingsStandardTimes>;draft:ReturnType<typeof settingsStandardTimes>;
 currentResult:SlaCalculationResult;draftResult:SlaCalculationResult;graph:CalculationGraph;label:string;
};
export const SlaAdjustmentPreviewHost=createContext<{element:HTMLDivElement|null;setActive:Dispatch<SetStateAction<boolean>>;conditionsElement:HTMLDivElement|null;setConditionsElement:Dispatch<SetStateAction<HTMLDivElement|null>>;calculationError:string;setCalculationError:Dispatch<SetStateAction<string>>}|null>(null);
const span=(value:number|null)=>calculationSpanLabel(value,readableSlaMinutes);
const difference=(a:number|null,b:number|null)=>a===null||b===null?'—':a===b?'不变':(b>a?'+':'−')+span(Math.abs(b-a));
const nodeSpan=(row:SlaCalculationResult['rows'][number]|undefined)=>!row?'—':row.minutes!==null?span(row.minutes*60000):row.offsetDays!==null?`提前${row.offsetDays}天`:row.kind==='unlimited'?'按业务事件':'按目标日期';
export function SlaAdjustmentPreview({comparison,stage,busy,disabled=false,error,onClose,onSave}:{comparison:SlaAdjustmentComparison|null;stage:number;busy:boolean;disabled?:boolean;error:string;onClose():void;onSave():Promise<boolean>}){
 const host=useContext(SlaAdjustmentPreviewHost),header=useRef<HTMLElement>(null),setActive=host?.setActive;
 useEffect(()=>{if(!setActive)return;const trigger=document.activeElement as HTMLElement|null;setActive(true);const frame=requestAnimationFrame(()=>header.current?.querySelector<HTMLButtonElement>('button')?.focus());return()=>{cancelAnimationFrame(frame);setActive(false);requestAnimationFrame(()=>{if(trigger?.isConnected)trigger.focus();});};},[setActive]);
 const [viewedStage,setViewedStage]=useState(stage||2);
 const currentStage=comparison?.current.stages.find(value=>value.stage===viewedStage),draftStage=comparison?.draft.stages.find(value=>value.stage===viewedStage);
 const currentStageSpan=currentStage?.spanMs??currentStage?.knownPathMs??null,draftStageSpan=draftStage?.spanMs??draftStage?.knownPathMs??null;
 const content=<section className="sla-adjustment-preview" aria-label="调整结果预览">
  {host&&<header ref={header}><Button variant="secondary" onClick={onClose}>‹ 返回修改</Button><h2>预览调整结果</h2></header>}
  <p>{comparison?.label??'本次试算依据待读取'} · 草稿未发布</p>{(error||host?.calculationError)&&<p role="alert">{error||host?.calculationError}</p>}
  <div className="sla-adjustment-summary">{[
   [currentStage?.spanMs===null||draftStage?.spanMs===null?'本阶段可确定路径':'本阶段用时',currentStageSpan,draftStageSpan],
   ['当前可确定路径',comparison?.current.knownPathMs??null,comparison?.draft.knownPathMs??null],
   [comparison?.graph.observationMode==='instance'?'所选订单范围总用时':'所选流程总用时',comparison?.current.overallMs??null,comparison?.draft.overallMs??null],
  ].map(([label,before,after])=><section key={String(label)}><h3>{label}</h3><div><span>{span(before as number|null)}</span><span aria-hidden="true">→</span><strong>{span(after as number|null)}</strong></div><small>{difference(before as number|null,after as number|null)}{after===null?' · 有节点待确认':''}</small></section>)}</div>
  <div className="sla-preview-stage-scroll"><ol className="cockpit-policy-stages" aria-label="预览所选阶段">{JOURNEY_STAGES.map((item,index)=><li key={item.key}><button type="button" aria-pressed={viewedStage===index+1} onClick={()=>setViewedStage(index+1)}><span className="cockpit-policy-stage-ring"><svg viewBox="0 0 72 72" aria-hidden="true"><circle cx="36" cy="36" r="30"/><circle cx="36" cy="36" r="30"/></svg><b>{index+1}</b></span><strong>{item.label}</strong></button></li>)}</ol></div>
  {host&&<div className="sla-preview-conditions" ref={host.setConditionsElement}/>}
  {comparison&&<div className="sla-adjustment-stages">{JOURNEY_STAGES.map((item,index)=>{const rows=comparison.draftResult.rows.filter(row=>row.stage===index+1);if(!rows.length)return null;return <details key={item.key} open={viewedStage===index+1}><summary>{index+1}. {item.label}</summary><div className="sla-calculation-table" tabIndex={0} role="region" aria-label={item.label+'调整对比'}><table><thead><tr><th>节点</th><th>调整前</th><th>调整后</th><th>试算完成</th><th>用时变化</th></tr></thead><tbody>{rows.map(row=>{const before=comparison.currentResult.rows.find(value=>value.id===row.id);return <tr key={row.id}><th>{row.label}{row.applicable==='unknown'&&<small>适用范围待确认</small>}{row.includedIn&&<small>已计入所属窗口</small>}</th><td>{nodeSpan(before)}</td><td>{nodeSpan(row)}</td><td>{row.end.at?slaTargetLabel(row.end):row.applicable==='no'?'不适用':'待确认'}</td><td>{difference(before?.minutes==null?null:before.minutes*60000,row.minutes===null?null:row.minutes*60000)}</td></tr>;})}</tbody></table></div></details>;})}</div>}
  <p className="sla-draft-publication-note">保存后仍是草稿。发布新标准须另行确认，在办订单不变。</p><footer><Button variant="secondary" disabled={busy} onClick={onClose}>返回修改</Button><Button disabled={busy||disabled} onClick={()=>{void onSave().then(saved=>{if(saved)onClose();});}}>{busy?'正在保存…':'确认保存草稿'}</Button></footer>
 </section>;
 return host?.element?createPortal(content,host.element):<CockpitHomeDialog title="调整结果预览" onClose={onClose}>{content}</CockpitHomeDialog>;
}
