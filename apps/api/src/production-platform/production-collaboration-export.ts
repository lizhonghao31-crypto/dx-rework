import type {ProductionCollaboration} from '@dx-rework/contracts/production-collaboration';
import type {WorkbookSheet} from '../reporting/xlsx-workbook.js';
export function productionCollaborationSheets(data:ProductionCollaboration|undefined):WorkbookSheet[]{
 if(!data)return [];
 return [
  {name:'人员协作口径',rows:[['观察时点',data.asOf],['已核子集原问题去重',data.globalProblemCount],...data.scopeUnknown.map(row=>['筛选归属待核',row.orderId,row.lineId??'原母单',row.reason]),['未核人员关联的原问题',data.unattributedProblems.length],['个人责任',data.personalResponsibility.reason],...data.limitations.map(reason=>['限制',reason])]},
  {name:'负荷与明确经办',rows:[['人员','原人员ID','任务所属岗位','原节点','当前主办未完任务','实际办理任务','涉及问题次数','涉及任务数','本次可见关联任务数（非排查分母）','问题率'],...data.summary.map(row=>[row.person.name,row.person.id,row.role,row.nodeKey,row.currentTasks,row.handledTasks,row.involvedProblems,row.involvedTasks,row.scopeTasks,'待核：缺完整排查分母'])]},
  {name:'原主办接续',rows:[['母单','原任务','节点','当前主办','本次有效截止','截止说明','截止边界','截止时主办（非过错）','当时主办','负责自','负责至','原依据','具体未知'],...data.tasks.flatMap(task=>(task.intervals.length?task.intervals:[null]).map(interval=>[task.orderId,task.taskId,task.label,task.currentAssignee?.name??'未分派',task.deadline??'无独立截止或待核',task.deadlineExplanation,task.deadlineExclusive?'此时刻前；日期型截止为上一业务日日终':'含该时刻',task.deadlinePending?'尚未到本次截止':task.deadline?task.assigneeAtDeadline?.name??'历史待核':'不适用或待核独立截止',interval?.person?.name??'未核或当时未分派',interval?.from??'缺业务生效',interval?.to??'本次观察时点',interval?.sourceRefs.join('；')??'',task.unknown.join('；')]))]},
  {name:'原实际办理记录',rows:[['母单','任务','节点','原事件','办理种类','实际提交人','原人员ID','有效发生（含原订正）','时间核验','原提交登记'],...data.tasks.flatMap(task=>task.handlers.map(event=>[task.orderId,task.taskId,task.label,event.eventId,event.kind,event.person.name,event.person.id,event.occurredAt??'缺业务发生',event.verified?'已核':'未核',event.recordedAt]))]},
  {name:'原涉及问题',rows:[['母单','任务','原问题','类型','原状态','原记录办理人员（非过错）','原证据'],...data.tasks.flatMap(task=>task.problems.map(problem=>[task.orderId,task.taskId,problem.id,problem.kind,problem.state,problem.involved.map(person=>person.name).join('；'),problem.sourceRefs.join('；')])),...data.unattributedProblems.map(problem=>[problem.orderId,'未核人员关联',problem.id,problem.kind,'沿原PO当前事实','不归给当前主办',problem.sourceRefs.join('；')])]},
 ];
}
