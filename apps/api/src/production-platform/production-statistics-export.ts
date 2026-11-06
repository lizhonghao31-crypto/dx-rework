import {businessValue} from '@dx-rework/contracts/business-display';
import type {ProductionStatisticsResponse,StatisticsTime} from '@dx-rework/contracts/production-statistics';
import type {WorkbookSheet} from '../reporting/xlsx-workbook.js';

const quantity=(value:number|null)=>value===null?'未知':value;
const timeValue=(time:StatisticsTime)=>time.at??time.date??'';
const timeState=(time:StatisticsTime)=>time.quality==='unverified'?'业务发生时间未核实':time.precision==='unknown'?'时间缺件':time.precision==='date'?'仅原业务日期':'已核业务时刻';
/** Export only the saved, already-authorized result. Never join current source values. */
export function productionEvidenceSheets(snapshot:ProductionStatisticsResponse):WorkbookSheet[]{
 const {materials,windows,problems,reworks,factories}=snapshot.result;
 const factoryName=(id:string|null)=>id===null?'归厂待核':factories.find(factory=>factory.factoryId===id)?.factoryName??'原归厂范围，名称未核';
 return [
  {name:'发料范围',rows:[
   ['需求范围','PO实体','归属工厂','物料','原单位','适用要求','有效发出','已核发出小计','状态','首批业务发生','首批时间状态','最近业务发生','发齐业务发生','具体未知'],
   ...materials.map(material=>[
    material.requirement.requirementId,material.requirement.lineId??'整单范围，不按PO复制数量',factoryName(material.requirement.factoryId),material.requirement.kind,material.requirement.unit,
    quantity(material.requirement.required),quantity(material.effectiveQuantity),material.knownEffectiveQuantity,
    {complete:'已发齐',partial:'部分发出','not-sent':'尚未发出','not-applicable':'不适用',unknown:'范围待核'}[material.state],
    timeValue(material.first),timeState(material.first),timeValue(material.latest),timeValue(material.covered),material.unknown.join('；'),
   ]),
  ]},
  {name:'发料原业务时间',rows:[
   ['需求范围','发出依据','原适用范围版本','原有效发出量','原单位','原业务发生','时间状态','当前适用范围版本'],
   ...materials.flatMap(material=>material.requirement.events.map(event=>[
    material.requirement.requirementId,event.id,event.scopeVersion,event.effectiveQuantity,material.requirement.unit,timeValue(event.time),timeState(event.time),material.requirement.scopeVersion,
   ])),
  ]},
  {name:'责任窗口',rows:[
   ['母单','原窗口','节点','窗口版本','当前主办','状态','已到期','到期履约','完成周期秒','未完年龄秒','已知等待秒','等待覆盖','排除或未知'],
   ...windows.map(row=>[
    row.window.orderId,row.window.id,row.window.label,row.window.version,row.window.assigneeName??'主办尚未核到',
    {pending:'等待前置',ready:'可以办理',active:'执行中',blocked:'明确阻断',paused:'已暂停',completed:'已完成',cancelled:'已取消',unknown:'状态待核'}[row.window.state],
    row.due===null?'不可判定':row.due?'已到期':'尚未到期',row.onTime===null?'不可判定':row.onTime?'按期':'未按期',
    quantity(row.completedSeconds),quantity(row.unfinishedAgeSeconds),row.knownWaitingSeconds,
    {complete:'完整可证',partial:'仅已核部分区间',unknown:'覆盖待核'}[row.waitingCoverage],
    [row.window.excludedReason,...row.unknown].filter(Boolean).join('；'),
   ]),
  ]},
  {name:'当前节点负荷',rows:[
   ['母单','原任务或批次','范围','节点','状态','是否当前负荷','当前主办','工厂','排除原因'],
   ...snapshot.result.workload.map(item=>[item.orderId,item.id,item.kind==='task'?'原数字任务':'原工厂生产批次',item.label,{pending:'等待前置',ready:'可以办理',active:'执行中',blocked:'明确阻断',paused:'已暂停',completed:'已结束',cancelled:'已取消',unknown:'状态待核'}[item.state],item.active?'是':'否',item.assigneeName??'原范围未登记当前个人主办',item.factoryName??'此任务未归属单一工厂',item.excludedReason??'']),
  ]},
  {name:'问题与时间',rows:[
   ['问题','母单','涉及PO','问题类型','是否明确阻断','原因分类','原文说明','状态','发生','发生时间状态','首次发现','登记','明确解决','复发关联'],
   ...problems.map(problem=>[
    problem.id,problem.orderId,problem.lineIds.join('；'),problem.kind,problem.blocking?'是':'否',problem.reasonCode??'待归类',problem.description,
    {current:'当前仍在',resolved:'已明确解决',unknown:'生命周期待核'}[problem.state],
    timeValue(problem.occurred),timeState(problem.occurred),timeValue(problem.observed),timeValue(problem.recorded),timeValue(problem.resolved),problem.recurrenceOf??'',
   ]),
  ]},
  {name:'原返工与做尾',rows:[
   ['母单','PO实体','原作业单','业务类型','原单状态','本单输入量','原工序','本工序有效报工','原报工依据','范围限制'],
   ...reworks.flatMap(rework=>(rework.processes.length?rework.processes:[null]).map(process=>[
    rework.orderId,rework.lineId,rework.reworkId,{qc_rework:'不良返工',inhouse_finishing:'普通做尾',unknown:'业务类型待核'}[rework.kind],businessValue('status',rework.status),
    quantity(rework.inputQuantity),process?.processName??'工序结果尚未核到',quantity(process?.reportedQuantity??null),process?.reportIds.join('；')??'',rework.unknown.join('；'),
   ])),
  ]},
 ];
}
