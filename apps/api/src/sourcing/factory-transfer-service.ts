import type {PoolClient} from "pg";
import {randomUUID} from "node:crypto";
import {ApplicationError} from "../platform/errors.js";

type Query=Pick<PoolClient,"query">;
export async function factoryTransferLines(client:Query,caseId:string,decisionId:string) {
  // Report writes acquire the same case lock before the production lock.
  await client.query("SELECT production_order_id FROM sourcing_production_orders WHERE sourcing_case_id=$1 FOR UPDATE",[caseId]);
  const result=await client.query<{position:number;planned_quantity:number;completed_quantity:number;quantity:number}>(
    "SELECT * FROM sourcing_factory_remaining_lines($1,$2) ORDER BY position",[caseId,decisionId]);
  if(!result.rows.length)throw new ApplicationError("INVALID_STATE_TRANSITION","生产厂归属与当前转厂基准不一致，不能猜测历史报量归属",409);
  if(!result.rows.some(line=>line.quantity>0))throw new ApplicationError("INVALID_STATE_TRANSITION","当前加工厂已无未完工余量可转厂",409);
  return result.rows;
}
export async function transferProductionFactory(client:Query,caseId:string,fromDecisionId:string,decisionId:string,eventId:string) {
  const production=(await client.query<{production_order_id:string}>("SELECT production_order_id FROM sourcing_production_orders WHERE sourcing_case_id=$1 FOR UPDATE",[caseId])).rows[0];
  if(!production)return;
  const lines=await factoryTransferLines(client,caseId,fromDecisionId);
  await client.query(`INSERT INTO sourcing_production_factory_transfers(factory_decision_id,production_order_id,from_decision_id,operation_event_id)
    SELECT $1,$2,$3,$4 FROM operation_events WHERE event_id=$4`,[decisionId,production.production_order_id,fromDecisionId,eventId]);
  for(const line of lines)await client.query(`INSERT INTO sourcing_production_factory_transfer_lines(factory_decision_id,position,retained_quantity,transferred_quantity)
    VALUES($1,$2,$3,$4)`,[decisionId,line.position,line.completed_quantity,line.quantity]);
  await client.query(`INSERT INTO sourcing_production_transitions(production_transition_id,production_order_id,factory_decision_id,sequence,status,business_date,actor_id,operation_event_id,created_at)
    SELECT $1,$2,$3,1,'in_production',(transfer.effective_at AT TIME ZONE 'Asia/Shanghai')::date,event.actor_id,event.event_id,transfer.effective_at FROM operation_events event JOIN sourcing_production_factory_transfers transfer ON transfer.factory_decision_id=$3 WHERE event.event_id=$4`,
    [randomUUID(),production.production_order_id,decisionId,eventId]);
}
