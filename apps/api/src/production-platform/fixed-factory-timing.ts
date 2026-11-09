import type {PoolClient} from 'pg';
import type {FactoryWindow} from './factory-batch-timing.js';
import {fixedCraftSteps} from './fixed-craft-steps.js';
import {factoryStepLedger} from './factory-step-ledger.js';
import {factoryBatchLedger,type FactoryScope,type BatchFact,type BatchCheck} from './factory-batch-ledger.js';
import {FixedTimelineAdoptionRepository} from './fixed-timeline-adoptions.js';
import {shiftFixedTimeline} from './fixed-timeline-targets.js';
import {firstContractBusinessReady} from './contract-business-ready.js';
import {readFixedOrderRoute} from './fixed-order-route.js';

const latest=(values:Array<Date|string|null|undefined>)=>values.length&&values.every(Boolean)?new Date(Math.max(...values.map(value=>new Date(value!).getTime()))).toISOString():null;
export async function fixedFactoryBatchTiming(db:Pick<PoolClient,'query'>,orderId:string,row:{preparation_id:string;sla_snapshot_id:string;completed_at:Date|string|null},lines:FactoryScope[],facts:BatchFact[],checks:BatchCheck[]){
 const saved=await new FixedTimelineAdoptionRepository(db).existing({kind:'order',id:orderId});if(!saved)throw Error('本路线缺少原冻结计划');
 const scope=await readFixedOrderRoute(db,saved,row.preparation_id),workItems=[...(scope?.work??[]),...saved.input.work];
 const steps=await fixedCraftSteps(db,row.preparation_id),stepLedger=steps.length?factoryStepLedger(lines,facts,checks,steps):null;
 const ledger=stepLedger??factoryBatchLedger(lines,facts,checks,true),warning=saved.input.unified.values.parameters.warning_ratio!.value;
 const ratio=warning.kind==='ratio'?warning.percent/100:0.7,windows:FactoryWindow[]=[];
 const add=(key:string,kind:FactoryWindow['kind'],nodeId:string,enteredAt:string|null,complete:boolean,completedAt:string|null,stepRef?:string,lineId?:string)=>{
  const work=workItems.find(work=>work.id===nodeId),minutes=work?.responsibilitySlaRef?work.responsibilityMinutes??null:null;
  const shift=(fraction:number)=>enteredAt&&minutes!==null&&work?.responsibilityCalendar?shiftFixedTimeline(enteredAt,minutes*fraction,work.responsibilityCalendar):null;
  windows.push({key,kind,parameterKey:work?.parameterKey??nodeId,enteredAt,complete,completedAt,minutes,calendarRef:work?.responsibilityCalendar??null,dueAt:shift(1),warningAt:shift(ratio),
   evidence:`adoption:${saved.adoptionId}:work:${nodeId}`,snapshotId:row.sla_snapshot_id,...(stepRef?{stepRef}:{}),...(lineId?{lineId}:{})});
 };
 for(const step of stepLedger?.steps??[]){
  const own=facts.filter(fact=>fact.payload.stepRef===step.step.stepId),sends=own.filter(fact=>fact.kind==='工艺发出');
  const first=sends.find(send=>!send.payload.fromReturnId||!own.some(fact=>fact.fact_id===send.payload.fromReturnId));
  const started=first?.occurred_at?new Date(first.occurred_at).toISOString():null;
  const complete=step.completion.every(scope=>scope.complete)&&step.pendingSends.every(send=>send.rows.every(line=>line.remaining===0));
  const route=scope?.route??saved.input.route??[];
  add(step.step.stepId,'process_logistics',route.find(position=>position.stepId===step.step.stepId&&position.phase==='logistics')!.nodeId,started,complete,complete?latest(own.filter(fact=>fact.kind==='工艺回仓').map(fact=>fact.occurred_at)):null,step.step.stepId);
  const returned=own.filter(fact=>fact.kind==='工艺回仓'),firstReturn=returned[0]?.occurred_at;
  const ownChecks=checks.filter(check=>returned.some(fact=>fact.fact_id===check.return_fact_id));
  add(`${step.step.stepId}:qc`,'bulk_qc',`bulk_qc:${step.step.stepId}`,firstReturn?new Date(firstReturn).toISOString():null,complete,
   complete?latest(ownChecks.map(check=>check.checked_at)):null,step.step.stepId);
 }
 const contract=await firstContractBusinessReady(db,orderId);
 for(const line of ledger.totals){
  const released=ledger.batches.flatMap(batch=>batch.rows.filter(row=>row.lineId===line.lineId&&row.allowDispatch).map(row=>row.checkedAt));
  const started=latest([steps.length?latest(released):row.completed_at,contract.at]);
  const dispatched=facts.filter(fact=>fact.kind==='仓库实际发厂'&&Array.isArray(fact.payload.lines)&&fact.payload.lines.some((scope:FactoryScope)=>scope.lineId===line.lineId));
  add(`dispatch:${line.lineId}`,'warehouse_dispatch','warehouse_dispatch',started,line.remaining===0,line.remaining===0?latest(dispatched.map(fact=>fact.occurred_at)):null,undefined,line.lineId);
 }
 return {routeSchemaVersion:2 as const,preparationId:row.preparation_id,snapshotId:row.sla_snapshot_id,warningRatio:ratio,windows,ledger,stepLedger};
}
