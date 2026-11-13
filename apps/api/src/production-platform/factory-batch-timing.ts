import type {FixedTimelineCalendar} from './fixed-timeline-targets.js';
import {firstContractBusinessReady} from './contract-business-ready.js';
import {slaApplications,appliedSlaWindow} from './sla-applied-window.js';
import type {PoolClient} from 'pg';
import {validateDigitalSlaSnapshot} from '@dx-rework/contracts/digital-sla';
import {factoryBatchLedger,type FactoryScope} from './factory-batch-ledger.js';
import {fixedFactoryBatchTiming} from './fixed-factory-timing.js';
import {fixedTaskPosition} from './fixed-craft-steps.js';
import {orderTimePolicyHistory} from './order-time-native-timing.js';
import {orderTimeRule} from '@dx-rework/contracts/order-time-plan';
import {shiftFixedTimeline} from './fixed-timeline-targets.js';
export type FactoryWindow={key:string;kind:'process_logistics'|'bulk_qc'|'warehouse_dispatch';enteredAt:string|null;dueAt:string|null;warningAt:string|null;completedAt:string|null;complete:boolean;evidence:string;minutes:number|null;parameterKey:string;applicationId?:string|null;snapshotId?:string;lineId?:string;stepRef?:string;calendarRef?:FixedTimelineCalendar|null;notificationEnabled?:boolean;orderTimePlanRef?:string;warningRatio?:number;craftLabel?:string};
const latest=(values:Array<Date|string|null|undefined>)=>values.every(Boolean)&&values.length?new Date(Math.max(...values.map(v=>new Date(v!).getTime()))).toISOString():null;
/** Batch windows derive only from original factory facts and the preparation's frozen standard. */
export async function factoryBatchTiming(db:Pick<PoolClient,'query'>,orderId:string){
 const available=(await db.query("SELECT to_regclass('digital_factory_routes') AS routes,to_regclass('digital_sla_order_snapshots') AS snapshots")).rows[0];if(!available?.routes||!available.snapshots)return null;
 const row=(await db.query(`SELECT r.*,to_jsonb(p)->>'sla_snapshot_id' AS sla_snapshot_id,s.rule_version,s.parameters_json,c.completed_at,to_jsonb(o)->>'order_time_managed' AS order_time_managed FROM digital_factory_routes r
 JOIN digital_bulk_preparations p USING(preparation_id) JOIN digital_sla_order_snapshots s ON s.snapshot_id::text=to_jsonb(p)->>'sla_snapshot_id'
 JOIN digital_production_orders o ON o.production_order_id=r.production_order_id
 JOIN digital_bulk_cutting_completions c USING(preparation_id) WHERE r.production_order_id=$1 AND to_jsonb(r)->>'workflow_version'='2'`,[orderId])).rows[0];
 if(!row)return null;
 const snapshot=validateDigitalSlaSnapshot({ruleVersion:row.rule_version,parameters:row.parameters_json});
 const warning=snapshot.parameters.warning_ratio!.value;if(warning.kind!=='ratio')throw Error('Invalid factory warning ratio');
 const minutes=(key:string)=>{const v=snapshot.parameters[key]?.value;if(v?.kind!=='duration')throw Error('Invalid factory duration');return v.minutes;};
 const facts=(await db.query('SELECT * FROM digital_factory_facts WHERE preparation_id=$1 ORDER BY sequence',[row.preparation_id])).rows;
 const checks=(await db.query('SELECT * FROM digital_factory_qc WHERE preparation_id=$1 ORDER BY sequence',[row.preparation_id])).rows;
 const lines=(await db.query(`SELECT p.line_id AS "lineId",r.actual_cut_count::int AS quantity FROM digital_production_po_lines p JOIN digital_production_child_lines l ON l.module='cutting' AND l.line_id=p.line_id JOIN current_cutting_records r ON r.cutting_order_id=l.child_id WHERE p.production_order_id=$1`,[orderId])).rows as FactoryScope[];
 if(row.route_schema_version===2)return fixedFactoryBatchTiming(db,orderId,row,lines,facts,checks);
 const ledger=factoryBatchLedger(lines,facts,checks,row.secondary_craft==='无');
 // Retain the first contract-ready fact; later contract revisions do not reset the opened window.
 const contract=await firstContractBusinessReady(db,orderId);
 const applications=await slaApplications(db,orderId);
 const policies=row.order_time_managed==='true'?await orderTimePolicyHistory(db,{kind:'order',id:orderId}):[];
 const windows:FactoryWindow[]=[];
 const add=(key:string,kind:FactoryWindow['kind'],enteredAt:string|null,complete:boolean,completedAt:string|null,duration:number,evidence:string,lineId?:string)=>{
  const parameterKey=kind==='process_logistics'?(row.secondary_craft==='印花'?'bulk_printing':row.secondary_craft==='绣花'?'bulk_embroidery':'bulk_print_embroidery'):kind;
  const applied=appliedSlaWindow(snapshot,parameterKey,`factory:${kind}:${key}`,applications),v=applied.snapshot.parameters[parameterKey]?.value,w=applied.snapshot.parameters.warning_ratio!.value;
  const chosen=policies.find(policy=>!enteredAt||Date.parse(policy.at)<=Date.parse(enteredAt)),rule=chosen?orderTimeRule(chosen.plan,parameterKey)?.rule:null;
  const minutes=chosen?rule?.kind==='work'||rule?.kind==='included'?rule.minutes:null:v?.kind==='duration'?v.minutes:duration,ratio=rule?rule.reminder.percent/100:w.kind==='ratio'?w.percent/100:warning.percent/100,calendar=chosen?rule?.calendar??null:'continuous';
  const shift=(factor:number)=>enteredAt&&minutes!==null&&calendar?shiftFixedTimeline(enteredAt,minutes*factor,calendar):null;
  windows.push({key,kind,parameterKey,enteredAt,complete,completedAt,minutes,evidence,applicationId:applied.applicationId,snapshotId:applied.snapshotId??row.sla_snapshot_id,
   dueAt:shift(1),warningAt:shift(ratio),...(chosen?{calendarRef:calendar,orderTimePlanRef:chosen.id,notificationEnabled:rule?.reminder.enabled===true,warningRatio:ratio}:{}),...(lineId?{lineId}:{})});
 };
 if(row.secondary_craft!=='无'){
  const craftKey=row.secondary_craft==='印花'?'bulk_printing':row.secondary_craft==='绣花'?'bulk_embroidery':'bulk_print_embroidery';
  for(const send of ledger.pendingSends){
   let origin=facts.find(f=>f.fact_id===send.factId);const visited=new Set<string>();
   while(origin?.payload.fromReturnId){if(visited.has(origin.fact_id))throw Error('Factory rework provenance cycle');visited.add(origin.fact_id);const returned=facts.find(f=>f.fact_id===origin!.payload.fromReturnId);origin=facts.find(f=>f.fact_id===returned?.payload.sendFactId);}
   const enteredAt=origin?.occurred_at?new Date(origin.occurred_at).toISOString():null;
   const done=send.rows.every(l=>l.remaining===0),returns=facts.filter(f=>f.kind==='工艺回仓'&&f.payload.sendFactId===send.factId);
   add(send.factId,'process_logistics',enteredAt,done,done?latest(returns.map(f=>f.occurred_at)):null,minutes(craftKey),`factory-send:${send.factId};original:${origin?.fact_id??'unknown'}`);
  }
  for(const batch of ledger.batches){const firstChecks=batch.rows.map(l=>checks.find(c=>c.return_fact_id===batch.factId&&c.line_id===l.lineId));const checked=firstChecks.every(Boolean);add(batch.factId,'bulk_qc',batch.occurredAt,checked,checked?latest(firstChecks.map(c=>c!.checked_at)):null,minutes('bulk_qc'),`factory-return:${batch.factId}`);
   for(const line of batch.rows){
    const firstRelease=checks.find(c=>c.return_fact_id===batch.factId&&c.line_id===line.lineId&&(c.result==='合格'||c.allow_dispatch));
    // Rework moves the remaining pieces to another physical batch, not to a fictitious dispatch.
    if(!firstRelease||line.reworked>0&&line.available===0&&line.sent===0)continue;
    const dispatched=facts.filter(f=>f.kind==='仓库实际发厂'&&f.payload.returnFactId===batch.factId&&f.payload.lines?.some((l:FactoryScope)=>l.lineId===line.lineId));
    const done=line.available===0&&line.sent>0;
    add(`${batch.factId}:${line.lineId}`,'warehouse_dispatch',latest([firstRelease.checked_at,contract.at]),done,done?latest(dispatched.map(f=>f.occurred_at)):null,minutes('warehouse_dispatch'),`factory-qc:${firstRelease.check_id}${contract.kind==='business'?`;${contract.evidence}`:''}`,line.lineId);
   }
  }
 }else{
  for(const line of ledger.totals){const dispatched=facts.filter(f=>f.kind==='仓库实际发厂'&&f.payload.lines?.some((l:FactoryScope)=>l.lineId===line.lineId));add(`cut:${line.lineId}`,'warehouse_dispatch',latest([row.completed_at,contract.at]),line.remaining===0,line.remaining===0?latest(dispatched.map(f=>f.occurred_at)):null,minutes('warehouse_dispatch'),`cut-completion:${row.preparation_id}${contract.kind==='business'?`;${contract.evidence}`:''}`,line.lineId);}
 }
 return {routeSchemaVersion:1 as const,preparationId:row.preparation_id,snapshotId:row.sla_snapshot_id,warningRatio:warning.percent/100,windows,ledger,stepLedger:null};
}
export async function factoryTaskTiming(db:Pick<PoolClient,'query'>,task:{task_id?:string;production_order_id:string|null;task_kind:string;route_instance_id:string},prepared?:Awaited<ReturnType<typeof factoryBatchTiming>>){
 if(!task.production_order_id||!['process_logistics','bulk_qc','warehouse_dispatch'].includes(task.task_kind))return null;
 const timing=prepared??await factoryBatchTiming(db,task.production_order_id);if(!timing||timing.preparationId!==task.route_instance_id)return null;
 const position=task.task_id&&timing.routeSchemaVersion===2&&timing.stepLedger?await fixedTaskPosition(db,task.task_id):null;
 const rows=timing.windows.filter(w=>w.kind===task.task_kind&&(!position?.step_id||w.stepRef===position.step_id)),open=rows.filter(w=>!w.complete);
 const selected=open.slice().sort((a,b)=>(a.dueAt?Date.parse(a.dueAt):Infinity)-(b.dueAt?Date.parse(b.dueAt):Infinity))[0]??(timing.routeSchemaVersion===2?rows[0]:undefined);
 const step=timing.routeSchemaVersion===2?timing.stepLedger?.steps.find(step=>step.step.stepId===position?.step_id)?.step:null;
 return {snapshotId:selected?.snapshotId??timing.snapshotId,parameterKey:selected?.parameterKey??task.task_kind,enteredAt:selected?.enteredAt??null,timeQuality:selected?.enteredAt?'补报未核实':'缺失',seconds:selected?.minutes==null?null:selected.minutes*60,
  ...(timing.routeSchemaVersion===2||selected?.orderTimePlanRef?{calendarRef:selected?.calendarRef??null}:{}),
  warningRatio:selected?.warningRatio??(timing.routeSchemaVersion===2?timing.warningRatio:selected?.warningAt&&selected.enteredAt&&selected.dueAt?(Date.parse(selected.warningAt)-Date.parse(selected.enteredAt))/(Date.parse(selected.dueAt)-Date.parse(selected.enteredAt)):timing.warningRatio),
  ...(selected?.craftLabel?{craftLabel:selected.craftLabel}:{}),...(selected?.notificationEnabled===undefined?{}:{notificationEnabled:selected.notificationEnabled}),
  ...(selected?.orderTimePlanRef?{orderTimePlanRef:selected.orderTimePlanRef,notificationEnabled:selected.notificationEnabled}:{}),
  basis:[...(step?[`craft-step:${step.stepId}`,`craft-kind:${step.craftKind}`]:[]),...(selected?[selected.key,selected.evidence]:[])],unknownWindows:open.filter(w=>!w.enteredAt).length};
}
