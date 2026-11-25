import type {PoolClient} from 'pg';
import type {CraftCheckQuantityScope} from '@dx-rework/contracts/factory-flow';
import {isRootActor} from '../access/business-authority.js';
import {ApplicationError} from '../platform/errors.js';
import type {TrustedActorContext} from '../tools/repositories.js';
import {DigitalProductionAccessPolicy,digitalForbidden} from './access-policy.js';

export type CraftProblemLocator={orderId:string;preparationId:string;stepRef:string;returnFactId:string;lineId:string;checkId:string};
type OriginalCheck={check_id:string;result:string;quantity_scope:unknown;returned_payload:unknown};

/** Legacy 「需处理」 never implies a quantity, even if the whole PO or
 * original return size is known. Quality and warehouse share actual pieces. */
export function countedCraftCheck(input:unknown,actualReturned:number):CraftCheckQuantityScope|null{
 if(!input||typeof input!=='object'||!Number.isSafeInteger(actualReturned)||actualReturned<=0)return null;
 const {inspectedQuantity,qualifiedQuantity,problemQuantity,unit}=input as Partial<CraftCheckQuantityScope>;
 if(unit!=='片'||typeof inspectedQuantity!=='number'||typeof qualifiedQuantity!=='number'||typeof problemQuantity!=='number'||
  ![inspectedQuantity,qualifiedQuantity,problemQuantity].every(Number.isSafeInteger)||inspectedQuantity<=0||
  inspectedQuantity>actualReturned||qualifiedQuantity<0||problemQuantity<0||qualifiedQuantity+problemQuantity!==inspectedQuantity)return null;
 return {inspectedQuantity,qualifiedQuantity,problemQuantity,unit};
}

export function qualifyCurrentCraftProblem(raw:OriginalCheck,locator:CraftProblemLocator){
 if(raw.check_id!==locator.checkId||raw.result!=='需处理'||!raw.returned_payload||typeof raw.returned_payload!=='object')return null;
 const returned=raw.returned_payload as {stepRef?:string;sendFactId?:string;lines?:readonly {lineId:string;quantity:number}[];warehouseMotion?:{factoryId?:string}};
 if(returned.stepRef!==locator.stepRef||!returned.sendFactId||!returned.warehouseMotion?.factoryId||!Array.isArray(returned.lines))return null;
 const quantities=returned.lines.filter(row=>row.lineId===locator.lineId);
 const count=quantities.length===1?countedCraftCheck(raw.quantity_scope,quantities[0]!.quantity):null;
 if(!count?.problemQuantity)return null;
 return {...locator,problemScopeId:locator.checkId,sourceSendFactId:returned.sendFactId,factoryId:returned.warehouseMotion.factoryId,
  ...count,actualReturned:quantities[0]!.quantity};
}

/** No broad authorization shortcut here. The original QC/rework command
 * supplies an already authorized order and uses its original lifecycle lock.
 * Each still-active counted scope can occupy only its own exact pieces. */
export async function readCurrentCraftProblem(db:Pick<PoolClient,'query'>,locator:CraftProblemLocator){
 const {rows}=await db.query<OriginalCheck>(`SELECT q.check_id,q.result,q.quantity_scope,f.payload AS returned_payload
  FROM digital_factory_routes route JOIN digital_factory_facts f USING(preparation_id)
  JOIN digital_production_po_lines po ON po.production_order_id=route.production_order_id AND po.line_id=$5
  JOIN digital_factory_facts outgoing ON outgoing.preparation_id=f.preparation_id AND outgoing.fact_id::text=f.payload->>'sendFactId'
   AND outgoing.kind='工艺发出' AND outgoing.payload->>'stepRef'=f.payload->>'stepRef'
   AND outgoing.payload#>>'{warehouseMotion,factoryId}'=f.payload#>>'{warehouseMotion,factoryId}'
  JOIN digital_factory_qc q ON q.check_id=$6 AND q.preparation_id=route.preparation_id AND q.return_fact_id=f.fact_id AND q.line_id=$5
   AND NOT EXISTS (SELECT 1 FROM digital_factory_qc newer WHERE to_jsonb(newer)->>'supersedes_check_id'=q.check_id::text)
  WHERE route.production_order_id=$1 AND route.preparation_id=$2 AND f.payload->>'stepRef'=$3
   AND f.fact_id=$4 AND f.kind='工艺回仓'`,
 [locator.orderId,locator.preparationId,locator.stepRef,locator.returnFactId,locator.lineId,locator.checkId]);
 return rows.length===1?qualifyCurrentCraftProblem(rows[0]!,locator):null;
}

/** Entry for the original rework mutation transaction. Match Warehouse/Factory
 * Flow's lock order before checking the actual role, route and latest check.
 * Reading an issue for N01 does not open or occupy a rework order. */
export async function lockCraftProblemAuthority(db:PoolClient,actor:TrustedActorContext,locator:CraftProblemLocator){
 await db.query("SELECT pg_advisory_xact_lock(hashtextextended('digital-production-task-lifecycle-v1',0))");
 const access=new DigitalProductionAccessPolicy(db);
 await access.assert(actor,'order',locator.orderId,'technical');
 const order=(await db.query(`SELECT production_order_id,design_style_no,primary_merchandiser_id,source_id
  FROM digital_production_orders WHERE production_order_id=$1 FOR UPDATE`,[locator.orderId])).rows[0];
 if(!order)return digitalForbidden();
 const root=isRootActor(actor);
 if(!root&&(!actor.actorRoles.includes('quality_control')||!await access.lockActiveRole(actor.actorId,'quality_control')))return digitalForbidden();
 const task=(await db.query<{task_id:string}>(`SELECT t.task_id FROM digital_production_tasks t
  JOIN digital_timeline_task_positions p USING(task_id) JOIN digital_production_task_access a USING(task_id)
  WHERE p.route_ref=$2 AND p.step_id=$3 AND a.production_order_id=$1 AND a.task_kind='bulk_qc'
    AND t.state IN ('ready','completed')`,[locator.orderId,locator.preparationId,locator.stepRef])).rows;
 if(task.length!==1||!root&&!await access.allowed(actor,'task',task[0]!.task_id,'execute'))return digitalForbidden();
 return {styleNo:order.design_style_no as string|null,merchandiserId:order.primary_merchandiser_id as string|null,taskId:task[0]!.task_id,sourceId:order.source_id as string|null};
}
export async function currentCraftProblemForRework(db:PoolClient,locator:CraftProblemLocator,source:Awaited<ReturnType<typeof lockCraftProblemAuthority>>){
 const invalid=(await db.query(`SELECT 1 FROM digital_order_closures WHERE production_order_id=$1
  UNION ALL SELECT 1 FROM digital_production_resource_lifecycle
  WHERE (resource_kind='order' AND resource_id=$1 OR resource_kind='source' AND resource_id=$2) AND state<>'active'`,
 [locator.orderId,source.sourceId])).rowCount;
 const evidence=invalid?null:await readCurrentCraftProblem(db,locator);
 if(!evidence)throw new ApplicationError('CONFLICT','原工艺问题范围已变更或不可办理，请刷新同批次检查',409);
 return {evidence,source};
}
export async function lockCraftProblemForOriginalRework(db:PoolClient,actor:TrustedActorContext,locator:CraftProblemLocator){
 return currentCraftProblemForRework(db,locator,await lockCraftProblemAuthority(db,actor,locator));
}

/** One original command identity for each explicitly selected physical portion.
 * Only a real, completed external work step exposes the next remaining scope. */
export async function readCraftRemediationScope(db:Pick<PoolClient,'query'>,checkId:string){
 const {rows}=await db.query<{rework_id:string;after_id:string|null;execution:'factory'|'internal';status:string;quantity:number;finished:boolean}>(`SELECT r.rework_order_id AS rework_id,
    r.craft_rework_after_id AS after_id,r.craft_rework_execution AS execution,r.status,r.rework_quantity::int AS quantity,
    r.craft_rework_execution='factory' AND craft_repair_can_continue(r.rework_order_id,$1) AS finished
  FROM rework_orders r WHERE r.source_craft_qc_check_id=$1 AND r.status NOT IN ('cancelled','deleted') ORDER BY r.created_at,r.rework_order_id`,[checkId]);
 const parents=new Set(rows.flatMap(row=>row.after_id?[row.after_id]:[]));
 const tip=rows.find(row=>!parents.has(row.rework_id))??null;
 const available=(await db.query<{remaining:number}>(`SELECT craft_repair_unallocated($1,NULL)::int AS remaining`,[checkId])).rows[0]?.remaining??0;
 return {rows,tip,available};
}

export async function reworkCraftLocator(db:PoolClient,actor:TrustedActorContext,reworkId:string){
 // The staged source is immutable. Legacy rows (including schemas without
 // this field) retain the original command before any craft-specific reads.
 const binding=(await db.query<{check_id:string|null}>(`SELECT to_jsonb(orders)->>'source_craft_qc_check_id' AS check_id
  FROM rework_orders orders WHERE orders.rework_order_id=$1 AND ($2 OR orders.created_by=$3) AND orders.status<>'deleted'`,
 [reworkId,isRootActor(actor),actor.actorId])).rows[0]?.check_id;
 if(!binding)return null;
 const {rows}=await db.query<CraftProblemLocator>(`SELECT route.production_order_id AS "orderId",q.preparation_id AS "preparationId",
  fact.payload->>'stepRef' AS "stepRef",q.return_fact_id AS "returnFactId",q.line_id AS "lineId",q.check_id AS "checkId"
  FROM digital_factory_qc q JOIN digital_factory_routes route USING(preparation_id)
  JOIN digital_factory_facts fact ON fact.fact_id=q.return_fact_id AND fact.preparation_id=q.preparation_id AND fact.kind='工艺回仓'
  WHERE q.check_id=$1`,[binding]);
 if(rows.length!==1)throw new ApplicationError('CONFLICT','原返工的工艺检查来源不可核实',409);
 return rows[0]!;
}
