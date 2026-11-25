import type {PreparationResource} from '@dx-rework/contracts/production-readiness';
import {acceptanceBusinessContext} from '../acceptance-clock/business-time.js';
import type {TrustedActorContext} from '../tools/repositories.js';
import {DigitalProductionAccessPolicy,digitalForbidden} from './access-policy.js';
import {preparationAvailable,type PreparationDB} from './preparation-material-repository.js';

/** Warehouse-center candidates, not pending receipts by themselves. Use the
 * same current assignment source as preparation: actual dispatch assignee,
 * then current order responsibility, otherwise current source responsibility.
 * A role by itself does not make unassigned work claimable. */
export async function assignedWarehousePreparationResources(db:PreparationDB,actor:TrustedActorContext):Promise<PreparationResource[]>{
 const policy=new DigitalProductionAccessPolicy(db);
 let active=false;
 for(const role of ['warehouse_receiver','warehouse_supervisor'] as const){
  if(actor.actorRoles.includes(role)&&await policy.activeRole(actor.actorId,role)){active=true;break;}
 }
 if(!active)return digitalForbidden();
 if(!await preparationAvailable(db))return [];
 const scene=acceptanceBusinessContext()?.scenarioId;
 const query=`WITH candidates AS (
  SELECT CASE WHEN o.production_order_id IS NULL THEN 'source' ELSE 'order' END AS kind,
    COALESCE(o.production_order_id, p.resource_id) AS id
  FROM digital_preparation_responsibilities p
  LEFT JOIN digital_production_orders o ON (p.resource_kind='order' AND o.production_order_id=p.resource_id)
    OR (p.resource_kind='source' AND o.source_id=p.resource_id)
  WHERE p.warehouse_worker_id=$1 AND (o.production_order_id IS NOT NULL OR p.resource_kind='source')
  UNION
  SELECT 'order',d.production_order_id FROM digital_bulk_dispatch d WHERE d.warehouse_worker_id=$1
 ), original AS (
  SELECT k.kind,k.id,o.production_order_id,CASE WHEN k.kind='source' THEN k.id ELSE o.source_id END AS source_id
  FROM candidates k LEFT JOIN digital_production_orders o ON k.kind='order' AND o.production_order_id=k.id
 ), current AS (
  SELECT s.*,COALESCE(d.warehouse_worker_id, r.warehouse_worker_id) AS warehouse_id
  FROM original s
  LEFT JOIN digital_bulk_dispatch d ON d.production_order_id=s.production_order_id
  LEFT JOIN LATERAL (
    SELECT p.warehouse_worker_id FROM digital_preparation_responsibilities p
    WHERE (p.resource_kind='order' AND p.resource_id=s.production_order_id)
       OR (p.resource_kind='source' AND p.resource_id=s.source_id)
    ORDER BY (p.resource_kind='order') DESC,p.version DESC LIMIT 1
  ) r ON true
 )
 SELECT kind,id FROM current c
 WHERE warehouse_id=$1
   AND NOT EXISTS(SELECT 1 FROM digital_production_resource_lifecycle l
     WHERE l.state<>'active' AND ((l.resource_kind='order' AND l.resource_id=c.production_order_id)
       OR (l.resource_kind='source' AND l.resource_id=c.source_id)))
   AND NOT EXISTS(SELECT 1 FROM digital_order_closures x WHERE x.production_order_id=c.production_order_id)
   ${scene?`AND EXISTS(SELECT 1 FROM acceptance_sla_clock_resources a WHERE a.scenario_id=$2
      AND a.resource_kind=c.kind AND a.resource_id=c.id)`:''}
 ORDER BY c.kind,c.id`;
 return (await db.query<PreparationResource>(query,scene?[actor.actorId,scene]:[actor.actorId])).rows;
}
