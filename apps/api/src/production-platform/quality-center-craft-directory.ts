import type {Pool} from 'pg';
import type {QualityDirectoryItem,QualityDirectoryQuery} from '@dx-rework/contracts/production-readiness';
import {acceptanceBusinessContext} from '../acceptance-clock/business-time.js';
import {isRootActor} from '../access/business-authority.js';
import type {TrustedActorContext} from '../tools/repositories.js';
import {DigitalProductionAccessPolicy,digitalForbidden} from './access-policy.js';
import {FactoryFlowService} from './factory-flow-service.js';
import {readTaskAccessForPage} from './journey-selection-access.js';

export async function qualityCenterCraftDirectory(pool:Pool,actor:TrustedActorContext,input:QualityDirectoryQuery){
 const db=await pool.connect();
 try{
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const root=isRootActor(actor),policy=new DigitalProductionAccessPolicy(db),scenario=acceptanceBusinessContext()?.scenarioId??null;
  if(!root&&(!actor.actorRoles.includes('quality_control')||!await policy.activeRole(actor.actorId,'quality_control')))return digitalForbidden();
  const authorities=(await db.query<{order_id:string;task_id:string}>(`SELECT a.production_order_id AS order_id,a.task_id
   FROM digital_production_task_access a JOIN digital_production_tasks t USING(task_id)
   WHERE a.task_kind='bulk_qc' AND a.required_role='quality_control' AND t.state IN ('ready','completed')
    AND ($1::uuid IS NULL OR a.assignee_id=$1) AND a.production_order_id IS NOT NULL
    AND ($2::uuid IS NULL OR EXISTS(SELECT 1 FROM acceptance_sla_clock_resources x WHERE x.scenario_id=$2 AND x.resource_kind='order' AND x.resource_id=a.production_order_id))`,
   [root?null:actor.actorId,scenario])).rows;
  const access=await readTaskAccessForPage(db,actor,authorities.map(row=>row.task_id));
  const permitted=new Set(authorities.filter(row=>access.get(row.task_id)?.execute&&access.get(row.task_id)?.parentTechnical).map(row=>row.task_id));
  const orders=[...new Set(authorities.flatMap(row=>permitted.has(row.task_id)?[row.order_id]:[]))];
  const flow=new FactoryFlowService(pool),items:QualityDirectoryItem[]=[],search=input.search.toLowerCase();
  for(const orderId of orders){
   const sheet=await flow.read(actor,orderId,db);
   for(const batch of sheet.batches??[]){
    const task=sheet.tasks.find(row=>row.taskKind==='bulk_qc'&&permitted.has(row.taskId)&&(row.stepRef??null)===(batch.stepRef??null));
    if(!task)continue;
    const origin=sheet.facts.find(row=>row.factId===batch.factId&&row.kind==='工艺回仓');
    const supplierName=typeof origin?.payload.supplier==='string'&&origin.payload.supplier.trim()?origin.payload.supplier:null;
    for(const row of batch.rows){
     const inspected=row.result!==null,identity=sheet.lines.find(line=>line.lineId===row.lineId);
     if(!identity||row.returned<=0||(input.status==='completed'?!inspected:inspected&&!(row.uninspectedQuantity&&row.uninspectedQuantity>0)))continue;
     if(search&&![task.identity?.designStyleNo,task.identity?.customerCode,identity.poNumber,supplierName].some(value=>value?.toLowerCase().includes(search)))continue;
     items.push({id:`${batch.factId}:${row.lineId}`,orderId,designStyleNo:task.identity?.designStyleNo??null,customerCode:task.identity?.customerCode??null,
      poNumber:identity.poNumber,supplierName,quantity:row.returned,qualifiedQuantity:row.qualifiedQuantity??null,dueAt:task.dueAt,inspected:input.status==='completed'&&inspected,
      result:row.result==='合格'?'passed':row.result==='需处理'?'problem':null,
      source:{kind:'craft',stepRef:batch.stepRef??null,returnFactId:batch.factId,lineId:row.lineId,taskId:task.taskId}});
    }
   }
  }
  items.sort((a,b)=>(a.dueAt??'9999').localeCompare(b.dueAt??'9999')||a.id.localeCompare(b.id));
  await db.query('COMMIT');
  return {page:input.page,total:items.length,items:items.slice((input.page-1)*15,input.page*15)};
 }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}
