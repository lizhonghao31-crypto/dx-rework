import type {Pool} from 'pg';
import type {QualityDirectoryItem,QualityDirectoryQuery} from '@dx-rework/contracts/production-readiness';
import {acceptanceBusinessContext} from '../acceptance-clock/business-time.js';
import {isRootActor} from '../access/business-authority.js';
import type {TrustedActorContext} from '../tools/repositories.js';
import {DigitalProductionAccessPolicy,digitalForbidden} from './access-policy.js';
import {factoryBatchLedger,type BatchCheck} from './factory-batch-ledger.js';
import {readTaskAccessForPage} from './journey-selection-access.js';

type NativeReturn={fact_id:string;order_id:string;task_id:string;step_ref:string|null;send_fact_id:string|null;line_id:string;
 design_style_no:string|null;customer_code:string|null;po_number:string|null;supplier_name:string|null;quantity:unknown;due_at:Date|null};

/** Read only the original scoped facts used by the catalog, never a full
 * FactoryFlow detail for each candidate order. */
export async function qualityCenterCraftDirectory(pool:Pool,actor:TrustedActorContext,input:QualityDirectoryQuery){
 const db=await pool.connect();
 try{
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const root=isRootActor(actor),policy=new DigitalProductionAccessPolicy(db),scenario=acceptanceBusinessContext()?.scenarioId??null;
  if(!root&&(!actor.actorRoles.includes('quality_control')||!await policy.activeRole(actor.actorId,'quality_control')))return digitalForbidden();
  const authorities=(await db.query<{task_id:string}>(`SELECT a.task_id
   FROM digital_production_task_access a JOIN digital_production_tasks t USING(task_id)
   JOIN digital_factory_routes route ON route.preparation_id=t.route_instance_id AND route.production_order_id=a.production_order_id
   WHERE a.task_kind='bulk_qc' AND a.required_role='quality_control' AND t.state IN ('ready','completed')
    AND ($1::uuid IS NULL OR a.assignee_id=$1) AND a.production_order_id IS NOT NULL
    AND ($2::uuid IS NULL OR EXISTS(SELECT 1 FROM acceptance_sla_clock_resources x WHERE x.scenario_id=$2
       AND x.resource_kind='order' AND x.resource_id=a.production_order_id))`,[root?null:actor.actorId,scenario])).rows;
  const access=await readTaskAccessForPage(db,actor,authorities.map(row=>row.task_id));
  const permitted=authorities.filter(row=>access.get(row.task_id)?.execute&&access.get(row.task_id)?.parentTechnical).map(row=>row.task_id);
  const returns=permitted.length?(await db.query<NativeReturn>(`WITH authorized AS (
    SELECT DISTINCT ON (route.preparation_id, CASE WHEN route.route_schema_version=2 THEN position.step_id END)
      t.task_id,route.preparation_id,route.production_order_id AS order_id,
      CASE WHEN route.route_schema_version=2 THEN position.step_id END AS step_id
    FROM digital_production_tasks t JOIN digital_factory_routes route ON route.preparation_id=t.route_instance_id
    LEFT JOIN digital_timeline_task_positions position ON position.task_id=t.task_id AND position.route_ref=route.preparation_id
    WHERE t.task_id=ANY($1::uuid[]) AND (route.workflow_version=2 OR route.route_schema_version=2)
    ORDER BY route.preparation_id,CASE WHEN route.route_schema_version=2 THEN position.step_id END,t.created_at,t.task_id
  ) SELECT f.fact_id,authorized.order_id,authorized.task_id,authorized.step_id::text AS step_ref,
    f.payload->>'sendFactId' AS send_fact_id,p.line_id,p.po_number,o.design_style_no,o.customer_code,
    supplier.name AS supplier_name,scope.value->'quantity' AS quantity,deadline.due_at
  FROM authorized JOIN digital_production_orders o ON o.production_order_id=authorized.order_id
  JOIN digital_factory_facts f ON f.preparation_id=authorized.preparation_id AND f.kind='工艺回仓'
    AND f.payload->>'stepRef' IS NOT DISTINCT FROM authorized.step_id::text
  CROSS JOIN LATERAL (SELECT CASE WHEN jsonb_typeof(f.payload->'supplier')='string' AND btrim(f.payload->>'supplier')<>''
    THEN f.payload->>'supplier' END AS name) supplier
  CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(f.payload->'lines')='array' THEN f.payload->'lines' ELSE '[]'::jsonb END) scope(value)
  JOIN digital_production_po_lines p ON p.production_order_id=authorized.order_id AND p.line_id::text=scope.value->>'lineId'
  LEFT JOIN LATERAL (
    SELECT r.due_at FROM digital_production_deadline_revisions r
    JOIN digital_production_deadline_policies policy ON policy.node_key=r.policy_node_key AND policy.version=r.policy_version
    JOIN app_users u ON u.id=r.changed_by WHERE r.task_id=authorized.task_id ORDER BY r.revision_id DESC LIMIT 1
  ) deadline ON true
  WHERE $2='' OR EXISTS(SELECT 1 FROM unnest(ARRAY[o.design_style_no,o.customer_code,p.po_number,supplier.name]) field
    WHERE strpos(lower(field),lower($2))>0)`,[permitted,input.search.trim()])).rows:[];
  const returnIds=[...new Set(returns.map(row=>row.fact_id))],byReturn=new Map<string,BatchCheck[]>();
  if(returnIds.length)for(const row of (await db.query<BatchCheck>(`SELECT check_id,return_fact_id,line_id,result,allow_dispatch,dispatch_reason,checked_at,quantity_scope,supersedes_check_id
   FROM digital_factory_qc WHERE return_fact_id=ANY($1::uuid[]) ORDER BY sequence`,[returnIds])).rows){
   const current=byReturn.get(row.return_fact_id);
   if(current)current.push(row);else byReturn.set(row.return_fact_id,[row]);
  }
  const items:QualityDirectoryItem[]=[];
  for(const original of returns){
   const quantity=original.quantity;
   if(typeof quantity!=='number'||!Number.isSafeInteger(quantity)||quantity<1)continue;
   const row=factoryBatchLedger([],[{fact_id:original.fact_id,kind:'工艺回仓',occurred_at:null,
    payload:{sendFactId:original.send_fact_id,lines:[{lineId:original.line_id,quantity}]}}],byReturn.get(original.fact_id)??[],false).batches[0]?.rows[0];
   if(!row)continue;
   const inspected=row.result!==null;
   if(input.status==='completed'?!inspected:inspected&&!(row.uninspectedQuantity&&row.uninspectedQuantity>0))continue;
   items.push({id:original.fact_id+':'+original.line_id,orderId:original.order_id,designStyleNo:original.design_style_no,customerCode:original.customer_code,
    poNumber:original.po_number,supplierName:original.supplier_name,quantity,qualifiedQuantity:row.qualifiedQuantity??null,
    dueAt:original.due_at?.toISOString()??null,inspected:input.status==='completed'&&inspected,
    result:row.result==='合格'?'passed':row.result==='需处理'?'problem':null,
    source:{kind:'craft',stepRef:original.step_ref,returnFactId:original.fact_id,lineId:original.line_id,taskId:original.task_id}});
  }
  items.sort((a,b)=>(a.dueAt??'9999').localeCompare(b.dueAt??'9999')||a.id.localeCompare(b.id));
  await db.query('COMMIT');
  return {page:input.page,total:items.length,items:items.slice((input.page-1)*15,input.page*15)};
 }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}
