import type {JourneyNode,OrderJourney} from '@dx-rework/contracts/digital-production-journey';
import type {factorySlaEvidence} from './factory-sla-evidence.js';
type NativeFactory=NonNullable<Awaited<ReturnType<typeof factorySlaEvidence>>>;
type Task={task_id:string;task_kind:string;route_instance_id:string};
/** Whole-order permission is checked by the caller. Bind the original route and
 * actual task instance, without requiring a generic task D or an enrolled plan. */
export function attachJourneyFactoryDeadlines(nodes:JourneyNode[],tasks:Task[],factory:NativeFactory,lines:OrderJourney['lines']){
 const visible=new Map(lines.map(line=>[line.id,line]));
 for(const node of nodes){
  const task=tasks.find(task=>task.task_id===node.instanceId&&task.task_kind===node.key&&task.route_instance_id===factory.preparationId);
  if(!task||!['process_logistics','bulk_qc','warehouse_dispatch'].includes(node.key))continue;
  const windows=factory.windows.filter(window=>window.kind===node.key&&window.lineIds.every(id=>visible.has(id)));
  if(!windows.length)continue;
  node.nativeWindows=windows.map(window=>({evidence:window.evidence,scopeLabel:window.lineIds.length?window.lineIds.map(id=>{const line=visible.get(id)!;return `PO ${line.po??'号码尚未取得'} · ${line.color}`;}).join(' / '):'原批次范围待核',startedAt:window.enteredAt,deadline:window.dueAt,warningAt:window.warningAt,completedAt:window.completedAt,complete:window.complete,...(window.snapshotId?{snapshotId:window.snapshotId}:{})}));
 }
}
