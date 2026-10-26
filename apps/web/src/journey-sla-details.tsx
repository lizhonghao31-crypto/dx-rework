import type {JourneyTiming,OrderJourney} from '@dx-rework/contracts/digital-production-journey';
import {journeyTime} from './digital-journey-cockpit-model.js';
export function slaTargetLabel(value:JourneyTiming['target']){
 if(!value.at)return '无可信目标时间';
 if(value.exclusive)return new Date(Date.parse(value.at)-1).toLocaleDateString('zh-CN',{timeZone:'Asia/Shanghai'})+' 当天结束';
 return journeyTime(value.at);
}
const basis={actual:'实际完成',remaining_estimate:'有效剩余工时预计',standard_window:'原责任窗口',plan:'计划推算（非开工许可）',unknown:'缺少预计依据'};
const statuses={not_applicable:'不适用',unknown:'时效未知',not_started:'未启动',running:'进行中',warning:'临期',overdue:'逾期',completed_on_time:'按时完成',completed_late:'超期完成',completed_unrated:'业务已完成，时效待核'};
export function JourneySlaDetails({order}:{order:OrderJourney}){
 const supervision=order.supervision;
 if(!supervision)return null;
 return <details className="journey-sla-details"><summary>当前有效时效与计划历史{supervision.currentRevision?` · v${supervision.currentRevision}`:''}</summary>
 <p className="journey-muted">{supervision.status==='limited'?'仅展示原授权节点，不读取整单计划历史。':supervision.status==='legacy_unenrolled'?'历史单沿原任务监督，不补造首版计划。':`首版 v${supervision.originalRevision} 保留；当前计划 v${supervision.currentRevision}。时间经过不代表业务完成。`}</p>
 {supervision.coverage.map(item=><p key={item.key}>{item.message}</p>)}
 <div className="journey-sla-table" role="region" aria-label="节点时效依据，可横向滚动" tabIndex={0}><table><thead><tr><th>节点 / 时效</th><th>节点目标 / 滚动预计</th><th>原计划 / 当前计划</th></tr></thead><tbody>{supervision.nodes.map(node=><tr key={node.id}><td>{node.label}<small>{statuses[node.status]}</small></td><td>{slaTargetLabel(node.target)}<small>预计：{node.forecast.at?slaTargetLabel(node.forecast):node.forecast.reasons.join('；')||'无有效预计'} · {basis[node.forecastBasis]}</small>{node.kind==='estimate'&&<small>物流仅预计，不是收货硬期限</small>}</td><td>{slaTargetLabel(node.original)}<small>当前：{slaTargetLabel(node.current)}</small>{node.actualStart&&<small>实际开始：{journeyTime(node.actualStart)}</small>}{node.actualEnd&&<small>实际完成：{journeyTime(node.actualEnd)}</small>}</td></tr>)}</tbody></table></div></details>;
}
