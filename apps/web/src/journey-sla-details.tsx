import {washingWindowChoices} from './washing-window-target.js';
import {CockpitRecordLink} from './cockpit-record-link.js';
import type {JourneyNode,JourneyTiming,OrderJourney} from '@dx-rework/contracts/digital-production-journey';
import {journeyTime,type CockpitContext} from './digital-journey-cockpit-model.js';
export function slaTargetLabel(value:JourneyTiming['target']){
 if(!value.at)return '无可信目标时间';
 if(value.exclusive)return new Date(Date.parse(value.at)-1).toLocaleDateString('zh-CN',{timeZone:'Asia/Shanghai'})+' 当天结束';
 return journeyTime(value.at);
}
type NodeDeadline=Pick<JourneyNode,'expectedAt'|'expectedKind'|'expectedPrecision'|'records'|'instanceId'|'timing'|'deadlineMode'|'deadlineExclusive'|'nativeWindows'>;
export const hasOriginalTaskDeadline=(node:NodeDeadline)=>Boolean(node.expectedAt&&node.expectedKind==='sla'&&node.records.some(record=>record.domain==='task'&&record.id===node.instanceId));
export const hasDateOnlyTarget=(node:NodeDeadline)=>Boolean(hasOriginalTaskDeadline(node)?node.deadlineMode==='date_target'&&node.deadlineExclusive===true:node.timing?.target.exclusive&&node.expectedAt===node.timing.target.at);
export const nodeTargetLabel=(node:NodeDeadline)=>node.nativeWindows?.length?node.nativeWindows.length===1?journeyTime(node.nativeWindows[0]!.deadline,'instant','本批无可信截止'):'各批原截止见节点':hasDateOnlyTarget(node)?slaTargetLabel({at:node.expectedAt,exclusive:true,reasons:[]}):journeyTime(node.expectedAt,node.expectedPrecision,'尚无可信截止');
/** A missing common D can mean distinct native batch deadlines, not no start. */
export function scopedDeadlineFallback(node:JourneyNode,target:NonNullable<JourneyNode['fixedTargets']>[number]){
 const refs=new Set(target.progress.ownSla.sourceRef?.split(';')??[]);
 const windows=[...(node.nativeWindows??[]),...(node.timing?.windows??[]),...(node.timings??[]).flatMap(timing=>timing.windows??[])].filter(window=>refs.has(window.evidence)&&window.startedAt&&window.deadline);
 return new Set(windows.map(window=>window.evidence)).size>1?'各批原截止见节点':'责任计时未开始或待核';
}
/** Original D is preserved separately before the rich v2 node adopts B. */
export function originalNodeDeadlineLabel(node:JourneyNode){
 const scoped=node.fixedTargets?.filter(target=>Object.hasOwn(target.progress.ownSla,'deadlineAt'));
 if(scoped?.length){const dates=scoped.map(target=>target.progress.ownSla.deadlineAt);return dates.every(at=>at&&at===dates[0])?journeyTime(dates[0]!, 'instant'):scoped.length>1?'各PO责任截止见节点':scopedDeadlineFallback(node,scoped[0]!);}
 const native=node.nativeTaskDeadline;
 if(native)return nodeTargetLabel({...node,expectedAt:native.at,expectedKind:'sla',expectedPrecision:native.precision,...(native.mode?{deadlineMode:native.mode}:{}),...(native.exclusive!==undefined?{deadlineExclusive:native.exclusive}:{})});
 if(node.fixedTargets?.length){if(node.nativeWindows?.length)return nodeTargetLabel(node);return node.timing?.target.at?slaTargetLabel(node.timing.target):'原截止待核';}
 return nodeTargetLabel(node);
}
const basis={actual:'实际完成',remaining_estimate:'有效剩余工时预计',standard_window:'原责任窗口',plan:'计划推算（非开工许可）',unknown:'缺少预计依据'};
const statuses={not_applicable:'不适用',unknown:'时效未知',not_started:'未启动',running:'进行中',warning:'临期',overdue:'逾期',completed_on_time:'按时完成',completed_late:'超期完成',completed_unrated:'业务已完成，时效待核',terminated:'计时已终止'};
function JourneyTimingTermination({timing}:{timing:Pick<JourneyTiming,'termination'>}){
 const stop=timing.termination;if(!stop)return null;
 const hours=(seconds:number|null)=>seconds===null?'待核':`${Number((seconds/3600).toFixed(4))}小时`;
 return <><small>{stop.kind==='special_closure'?'特殊结案':'取消'}：{journeyTime(stop.at,'instant','真实终止时间待核')}</small><small>终止前计时用时：{hours(stop.elapsedSeconds)} · 历史超时：{hours(stop.overdueSeconds)}</small></>;
}
export function JourneyTimingWindows({timing,showSnapshot=true,context,disabled=false,onNavigate}:{timing:Pick<JourneyTiming,'windows'>;showSnapshot?:boolean;context?:CockpitContext|undefined;disabled?:boolean;onNavigate?:((focus:string)=>CockpitContext)|undefined}){
 return <>{washingWindowChoices(timing.windows??[]).map(({evidence,window})=>{
  if(!window)return <small key={evidence} role="alert">原窗口资料冲突，不能选取或借用其他窗口。</small>;
  const focus='washing-window:'+evidence,selected=context?.materialFocus===focus;
  return <small key={evidence} data-washing-choice={evidence} aria-current={selected?'true':undefined}>{window.scopeLabel} · 原开始 {journeyTime(window.startedAt,'instant','尚未取得')} · 原截止 {journeyTime(window.deadline,'instant','本批无可信截止')} · {window.complete?'已完成':'尚未完成'}{window.completedAt?` ${journeyTime(window.completedAt)}`:''}{showSnapshot&&window.snapshotId?` · 冻结规则 ${window.snapshotId}`:''}{window.record&&context&&<span data-material-focus={focus}> · <button type="button" aria-pressed={selected} disabled={disabled||!onNavigate} onClick={()=>onNavigate?.(focus)}>选中本窗口</button> · <CockpitRecordLink record={window.record} context={{...context,materialFocus:focus}} disabled={disabled} onNavigate={onNavigate?()=>onNavigate(focus):undefined}>查看本窗口记录</CockpitRecordLink><span className="journey-muted"> · 窗口参考 {evidence.slice(-12)}</span></span>}</small>;
 })}</>;
}
const rangeBoundary=(at:string)=>new Date(Date.parse(at)+8*3600000).toISOString().replace('T',' ').replace(/\.000Z$/,'').replace(/Z$/,'');
export function logisticsRangeLabel(range:{fromInclusive:string;toExclusive:string}){
 return `${rangeBoundary(range.fromInclusive)}（含）至 ${rangeBoundary(range.toExclusive)}（不含），北京时间`;
}
function LogisticsRanges({node}:{node:JourneyTiming}){
 return <>{node.logisticsWindows!.map(window=><small key={window.evidence} className="journey-logistics-range">{window.supplierName} · 已登记发货日期 {window.shippedOn} · {window.arrivalRange?`预计到仓范围：${logisticsRangeLabel(window.arrivalRange)}`:'物流标准未知，不能计算到仓范围'}{window.estimateExpired?'；预计范围已过，请跟进实际物流':''}{window.hasReceived?'；对应工厂已有实际到仓记录，余量请在原回货区核对':''}。原记录仅有日期，未记录实际发货时刻。</small>)}</>;
}
export function JourneySlaDetails({order}:{order:OrderJourney}){
 const supervision=order.supervision;
 if(!supervision)return null;
 return <details className="journey-sla-details"><summary>当前有效时效与计划历史{supervision.currentRevision?` · v${supervision.currentRevision}`:''}</summary>
 <p className="journey-muted">{supervision.status==='limited'?'仅展示原授权节点，不读取整单计划历史。':supervision.status==='legacy_unenrolled'?'历史单沿原任务监督，不补造首版计划。':`首版 v${supervision.originalRevision} 保留；当前计划 v${supervision.currentRevision}。时间经过不代表业务完成。`}</p>
 {supervision.coverage.map(item=><p key={`${item.key}:${item.message}`}>{item.message}</p>)}{supervision.requestId&&<p>请求编号：{supervision.requestId}</p>}
 <div className="journey-sla-table" role="region" aria-label="节点时效依据，可横向滚动" tabIndex={0}><table><thead><tr><th>节点 / 时效</th><th>节点目标 / 滚动预计</th><th>原计划 / 当前计划</th></tr></thead><tbody>{supervision.nodes.map(node=><tr key={node.id}><td>{node.label}<small>{node.logisticsWindows?.length&&!node.assessmentIssue&&!node.actualStart&&!node.actualEnd&&!node.status.startsWith('completed')?'已登记发货日期':statuses[node.status]}</small>{node.provenRisk&&<small>{node.provenRisk==='overdue'?'另有可信批次已逾期':'另有可信批次已临期'}</small>}</td><td>{node.kind==='estimate'?'仅物流预计，无收货硬截止':node.windows?.length?'按各批原责任窗口核对':slaTargetLabel(node.target)}{node.logisticsWindows?.length?<LogisticsRanges node={node}/>:<small>预计：{node.forecast.at?slaTargetLabel(node.forecast):node.forecast.reasons.join('；')||'无有效预计'} · {basis[node.forecastBasis]}</small>}{node.windows?.length?<JourneyTimingWindows timing={node}/>:null}{node.kind==='estimate'&&<small>物流仅预计，不是收货硬期限</small>}</td><td>{slaTargetLabel(node.original)}<small>当前：{slaTargetLabel(node.current)}</small>{node.actualStart&&<small>实际开始：{journeyTime(node.actualStart)}</small>}{node.actualEnd&&<small>实际完成：{journeyTime(node.actualEnd)}</small>}<JourneyTimingTermination timing={node}/></td></tr>)}</tbody></table></div></details>;
}
