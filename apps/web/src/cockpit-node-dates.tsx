import {CockpitFixedTargetDates,CockpitNodeForecast} from './cockpit-fixed-schedule.js';
import type {JourneyNode,OrderJourney} from '@dx-rework/contracts/digital-production-journey';
import {journeyTime,type CockpitContext} from './digital-journey-cockpit-model.js';
import {forecastBasisLabels} from './cockpit-business-dates.js';
import {JourneyTimingWindows,nodeTargetLabel,slaTargetLabel} from './journey-sla-details.js';

export function CockpitNodeDates({node,order,context,disabled=false,onNavigate}:{node:JourneyNode;order:OrderJourney;context?:CockpitContext;disabled?:boolean;onNavigate?:(focus:string)=>CockpitContext}){
 const targets=order.businessProgress?.requirements.filter(row=>row.instanceIds.includes(node.instanceId)).flatMap(row=>row.targets)??[];
 const unique=[...new Map(targets.map(target=>[`${target.planId}:${target.scopeRef}:${target.at}`,target])).values()];
 const nativeTask=node.records.some(record=>record.domain==='task'&&record.id===node.instanceId);
 const timings=node.timings??[];
 const typedForecast=node.fixedTargets?.some(target=>target.progress.estimateKind!==undefined);
 const native=node.nativeWindows??[];
 const timingScope=(id:string,label:string)=>{const line=order.lines.find(line=>line.id===id.split(':')[1]);return line?`PO ${line.po??'号码尚未取得'} · ${line.color}`:label;};
 const scopeLabel=(scope:string)=>scope==='whole'?'本单':order.lines.filter(line=>scope===`po:${line.id}`).map(line=>`PO ${line.po??'号码尚未取得'} · ${line.color}`).join(' / ')||'对应范围待核实';
 return <>
  <CockpitNodeForecast node={node} order={order}/>
  <div><dt>{node.fixedTargets?.length?'节点目标：':nativeTask?'原任务截止：':'节点目标：'}</dt><dd>{node.fixedTargets?.length?<CockpitFixedTargetDates node={node} lines={order.lines}/>:<>{node.expectedAt?nodeTargetLabel({...node,nativeWindows:[]}):native.length||node.timing?.windows?.length||timings.some(t=>t.windows?.length||t.target.at)?'按下列各范围原截止核对':'尚无可信截止'}</>}</dd></div>
  {node.nativeTaskDeadline&&<div><dt>原任务截止：</dt><dd>{nodeTargetLabel({...node,expectedAt:node.nativeTaskDeadline.at,expectedKind:'sla',expectedPrecision:node.nativeTaskDeadline.precision,...(node.nativeTaskDeadline.mode?{deadlineMode:node.nativeTaskDeadline.mode}:{}),...(node.nativeTaskDeadline.exclusive!==undefined?{deadlineExclusive:node.nativeTaskDeadline.exclusive}:{}),nativeWindows:[]})}</dd></div>}
  {native.length>0&&<div><dt>原批次时限：</dt><dd><JourneyTimingWindows timing={{windows:native}} showSnapshot={false} context={context} disabled={disabled} onNavigate={onNavigate}/></dd></div>}
  {!native.length&&timings.map(timing=><div key={timing.id}><dt>{timingScope(timing.id,timing.label)}{timing.kind==='estimate'?'物流预计：':'原截止：'}</dt><dd>{timing.kind==='estimate'?<>{slaTargetLabel(timing.forecast)}（仅预计）</>:timing.windows?.length?<JourneyTimingWindows timing={timing} context={context} disabled={disabled} onNavigate={onNavigate}/>:slaTargetLabel(timing.target)}</dd></div>)}
  {!node.fixedTargets?.length&&unique.map(target=><div key={`${target.planId}:${target.scopeRef}:${target.at}`}><dt>已采用计划完成：</dt><dd>{scopeLabel(target.scopeRef)} · {journeyTime(target.at,target.precision)}{target.precision==='date'?' 当天结束':''} · 计划 v{target.revision}</dd></div>)}
  {!typedForecast&&node.timing&&(!node.fixedTargets?.length||node.timing.forecast.at)&&<div><dt>{node.fixedTargets?.length?'当前预计：':'预计完成：'}</dt><dd>{node.timing.forecast.at?slaTargetLabel(node.timing.forecast):node.timing.forecast.reasons[0]??'预计依据尚未齐全'}{!node.fixedTargets?.length&&<> · {forecastBasisLabels[node.timing.forecastBasis]}</>}</dd></div>}
  {!native.length&&node.timing?.windows?.length?<div><dt>各批原责任窗口：</dt><dd><JourneyTimingWindows timing={node.timing} context={context} disabled={disabled} onNavigate={onNavigate}/></dd></div>:null}
  {node.productionSupervision&&<div><dt>生产监督：</dt><dd>{node.productionSupervision.state==='ended'?'生产监督已结束，查看原记录':node.productionSupervision.state==='unknown'?'监督状态尚未取得':node.productionSupervision.state==='partial'?'各厂监督状态不同，请逐项核对':'生产监督进行中'}{node.productionSupervision.windows.map((window,index)=><small key={index}>{window.scopeLabel} · {window.state==='finished'?'本厂监督已结束':window.reason??'监督依据尚未取得'}{window.state!=='finished'&&window.remindAt?` · 下次提醒 ${journeyTime(window.remindAt)}`:''}{window.state!=='finished'&&window.escalateAt?` · 升级提醒 ${journeyTime(window.escalateAt)}`:''}</small>)}</dd></div>}
  {node.inheritedResult&&<><div><dt>原成果完成：</dt><dd>{journeyTime(node.inheritedResult.actualAt,'instant','原完成时间尚未取得')}{node.inheritedResult.actualAt&&node.inheritedResult.quality!=='verified'?'（待核）':''}</dd></div><div><dt>本轮采用完成：</dt><dd>{journeyTime(node.inheritedResult.adoptedAt,'instant',node.inheritedResult.reason)}</dd></div></>}
 </>;
}
