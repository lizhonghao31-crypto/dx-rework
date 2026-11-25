import type {Pool,PoolClient} from 'pg';
import {isRootActor} from '../access/business-authority.js';
import type {TrustedActorContext} from '../tools/repositories.js';
import {DigitalProductionAccessPolicy,digitalForbidden} from './access-policy.js';
import {factoryProductionFactsForOrders} from './factory-production-facts.js';
import {readTaskAccessForPage} from './journey-selection-access.js';

type Candidate={task_id:string;production_order_id:string;design_style_no:string|null;customer_code:string|null;assignee_id:string|null;assignee_name:string|null};

/** Native factory-process checks only. Arrivals and return-batch inspections
 * use other original facts. A role, a timeline target or a shipment record
 * alone never makes a factory inspection executable by this actor. */
export async function qualityCenterFactoryDirectory(pool:Pool,actor:TrustedActorContext,input:{page:number;search:string;status:'open'|'inspected'|'all'}){
 const db=await pool.connect();
 try{
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const policy=new DigitalProductionAccessPolicy(db),root=isRootActor(actor);
  if(!root&&(!actor.actorRoles.includes('quality_control')||!await policy.activeRole(actor.actorId,'quality_control')))return digitalForbidden();
  const candidates=await factoryInspectionCandidates(db,root?null:actor.actorId);
  const tasks=await readTaskAccessForPage(db,actor,candidates.map(row=>row.task_id));
  const authorized=new Map<string,Candidate>(),ambiguous=new Set<string>();
  for(const row of candidates){
   const allowed=tasks.get(row.task_id),id=row.production_order_id;
   if(!allowed?.parentTechnical||!allowed.execute||ambiguous.has(id))continue;
   if(authorized.has(id)){authorized.delete(id);ambiguous.add(id);continue;}
   authorized.set(id,row);
  }
  const facts=await factoryProductionFactsForOrders(db,[...authorized.keys()]);
  const search=input.search.trim().toLowerCase();
  const available=[...facts].flatMap(([id,state])=>{
   const candidate=authorized.get(id)!;
   return state.checks.flatMap(check=>{
    if(input.status==='open'&&check.inspected||input.status==='inspected'&&!check.inspected)return [];
    if(search&&![candidate.design_style_no,candidate.customer_code,check.supplierName,check.poNumber,check.color].some(value=>value?.toLowerCase().includes(search)))return [];
    return [{id:JSON.stringify([id,check.productionId,check.factoryDecisionId,check.lineId]),orderId:id,taskId:candidate.task_id,
     designStyleNo:candidate.design_style_no,customerCode:candidate.customer_code,assigneeName:candidate.assignee_name,...check}];
   });
  });
  available.sort((a,b)=>(a.targetDate??'9999').localeCompare(b.targetDate??'9999')||a.id.localeCompare(b.id));
  await db.query('COMMIT');
  return {page:input.page,total:available.length,items:available.slice((input.page-1)*15,input.page*15)};
 }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}

async function factoryInspectionCandidates(db:PoolClient,assignee:string|null){
 const {rows}=await db.query<Candidate>(`SELECT t.task_id,o.production_order_id,o.design_style_no,o.customer_code,a.assignee_id,u.display_name AS assignee_name
  FROM digital_production_task_access a JOIN digital_production_tasks t USING(task_id)
  JOIN digital_production_orders o ON o.production_order_id=a.production_order_id
  JOIN digital_factory_routes route ON route.preparation_id=t.route_instance_id AND route.production_order_id=o.production_order_id
  JOIN digital_bulk_preparations p ON p.preparation_id=route.preparation_id
  JOIN digital_instruction_documents d ON d.production_order_id=o.production_order_id AND d.published_version=p.instruction_version
  LEFT JOIN app_users u ON u.id=a.assignee_id
  WHERE a.task_kind='factory_production_qc' AND t.state IN ('ready','completed')
   AND ($1::uuid IS NULL OR a.assignee_id=$1)
   AND p.source_round=coalesce((SELECT max(round_number) FROM digital_development_rounds WHERE source_id=p.source_id),1)
   AND EXISTS(SELECT 1 FROM digital_production_child_links l WHERE l.production_order_id=o.production_order_id AND l.module='production')`,[assignee]);
 return rows;
}
