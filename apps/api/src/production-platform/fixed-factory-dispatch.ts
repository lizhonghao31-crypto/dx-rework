import type {PoolClient} from 'pg';
import {ApplicationError} from '../platform/errors.js';
import {fixedCraftSteps} from './fixed-craft-steps.js';
import {factoryStepLedger} from './factory-step-ledger.js';
import {factoryBatchReleaseAvailable,scopes,type FactoryScope} from './factory-batch-ledger.js';

/** The low-level native dispatch also verifies terminal scope. A direct caller
 * cannot turn an earlier craft's QC or an already consumed return into supply.
 * Caller retains original role/resource checks, lock and transaction.
 */
export async function assertFixedFactoryDispatch(db:Pick<PoolClient,'query'>,orderId:string,fact:{fact_id:string;preparation_id:string;payload:Record<string,unknown>}){
 const route=(await db.query("SELECT to_jsonb(r)->>'route_schema_version' AS version,preparation_id FROM digital_factory_routes r WHERE production_order_id=$1 AND preparation_id=$2",[orderId,fact.preparation_id])).rows[0];
 if(route?.version!=='2')return;
 const steps=await fixedCraftSteps(db,route.preparation_id);if(!steps.length)return;
 const fail=():never=>{throw new ApplicationError('FACTORY_FLOW_CONFLICT','发厂须使用本PO最后一道工艺已检查放行、尚未消耗的真实回仓数量',409);};
 if(fact.payload.stepRef!==steps.at(-1)!.stepId||typeof fact.payload.returnFactId!=='string')fail();
 const lines=(await db.query(`SELECT po.line_id AS "lineId",r.actual_cut_count::int AS quantity FROM digital_production_po_lines po
  JOIN digital_production_child_lines l ON l.module='cutting' AND l.line_id=po.line_id JOIN current_cutting_records r ON r.cutting_order_id=l.child_id
  WHERE po.production_order_id=$1 ORDER BY po.position`,[orderId])).rows as FactoryScope[];
 if(new Set(lines.map(line=>line.lineId)).size!==lines.length||!lines.length)fail();
 const facts=(await db.query('SELECT * FROM digital_factory_facts WHERE preparation_id=$1 AND fact_id<>$2 ORDER BY sequence',[route.preparation_id,fact.fact_id])).rows;
 const checks=(await db.query('SELECT * FROM digital_factory_qc WHERE preparation_id=$1 ORDER BY sequence',[route.preparation_id])).rows;
 const ledger=factoryStepLedger(lines,facts,checks,steps),batch=ledger.batches.find(batch=>batch.factId===fact.payload.returnFactId),requested=scopes(fact.payload.lines);
 if(!batch||ledger.quantityConflict||!requested.length||new Set(requested.map(line=>line.lineId)).size!==requested.length)fail();
 for(const line of requested){
  const row=batch!.rows.find(row=>row.lineId===line.lineId),remaining=ledger.totals.find(row=>row.lineId===line.lineId)?.remaining??0;
  if(!row||line.quantity>Math.min(factoryBatchReleaseAvailable(row),remaining))fail();
 }
}
