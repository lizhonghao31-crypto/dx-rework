import type {Pool,PoolClient} from 'pg';
import {z} from 'zod';
import {BulkPreparationService} from './bulk-preparation-service.js';
import {businessNow} from '../acceptance-clock/business-time.js';
import {readWarehouseFabricReceiptBasis} from './warehouse-fabric-report-lots.js';
import {warehouseCutoverScopeKey,warehouseCutoverScopesCurrent} from './warehouse-receipt-cutover-repository.js';
import {preparationAdoption,preparationContext,preparationHash} from './preparation-material-repository.js';
import {refreshPreparationWindows} from './production-readiness-repository.js';

const Subject=z.object({kind:z.enum(['order','source']),id:z.uuid()}).strict();
const Status=z.object({resource:Subject}).strict();
const Approval=z.object({
 resource:Subject,sourceId:z.uuid().nullable(),expectedGeneration:z.number().int().nonnegative(),requestId:z.uuid(),
 reason:z.string().trim().min(1).max(1000),scopes:z.array(z.object({key:z.string().min(1).max(700),
  investment:z.object({recordId:z.uuid(),version:z.number().int().positive()}).strict(),
  basisRevision:z.string().regex(/^[a-f0-9]{64}$/),
 }).strict()).min(1).max(100),
}).strict();
type Action='status'|'activate'|'safe-read';

const compare=(a:{key:string},b:{key:string})=>a.key.localeCompare(b.key);
async function observe(db:PoolClient,resource:z.infer<typeof Subject>){
 const asOf=businessNow().toISOString();
 const view=await readWarehouseFabricReceiptBasis(db,resource,asOf,true);
 const scopes=view.work.map(row=>({key:warehouseCutoverScopeKey(row),investment:row.purchase.original,
  basisRevision:row.reconciliation!.basisRevision,invested:row.purchase.invested,originalReceived:row.received,
  reconciliation:row.reconciliation,originalBalance:row.balance})).sort(compare);
 const windows=view.ctx.orderId?(await db.query(`SELECT kind,epoch,window_id,started_at,due_at,basis_json
  FROM digital_preparation_windows WHERE production_order_id=$1 ORDER BY kind,epoch`,[view.ctx.orderId])).rows:[];
 const oldReceipt=view.facts.filter(row=>row.kind==='fabric_receipt').map(row=>[row.recordId,row.version,row.valid,row.occurredAt]);
 const report=view.ctx.orderId?(await db.query(`SELECT event_id,occurred_at,payload->>'result' AS result
  FROM digital_production_task_events WHERE resource_kind='order' AND resource_id=$1 AND event_kind='bulk_fabric_report'
  ORDER BY recorded_at DESC,event_id DESC LIMIT 1`,[view.ctx.orderId])).rows[0]??null:null;
 return {view,asOf,scopes,windows,oldReceipt,report};
}

/** Only called by the fixed Acceptance operator, after DB identity and
 * deployed SHA checks. This is not a public API, not a production toggle. */
export async function warehouseReceiptCutover(pool:Pool,action:Action,releaseSha:string,operator:string,raw:unknown){
 if(!['status','activate','safe-read'].includes(action)||!/^\w[\w.-]{0,119}$/.test(operator)||!/^[a-f0-9]{40}$/.test(releaseSha))
  throw Error('Invalid warehouse cutover command identity');
 const input=action==='status'?Status.or(Approval).parse(raw):Approval.parse(raw),db=await pool.connect();
 try{
  await db.query(action==='status'?'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY':'BEGIN');
  if(action!=='status'){
   await db.query("SET LOCAL lock_timeout='8s'");
   await db.query("SELECT pg_advisory_xact_lock(hashtextextended('digital-production-task-lifecycle-v1',0))");
   const c=await preparationContext(db,input.resource);
   if(c.orderId)await db.query('SELECT 1 FROM digital_production_orders WHERE production_order_id=$1 FOR UPDATE',[c.orderId]);
   if(c.sourceId)await db.query('SELECT 1 FROM digital_production_sources WHERE source_id=$1 FOR UPDATE',[c.sourceId]);
  }
  const state=await observe(db,input.resource),{ctx,cutover}=state.view;
  const output={resource:input.resource,sourceId:ctx.sourceId,asOf:state.asOf,
   generation:cutover?.generation??0,mode:cutover?.mode??'legacy',scopes:state.scopes,originalReceipt:state.oldReceipt,windows:state.windows,fabricReport:state.report};
  if(action==='status'){await db.query('COMMIT');return output;}
  const approved=Approval.parse(input);
  if(ctx.sourceId!==approved.sourceId||ctx.orderId&&input.resource.kind!=='order')throw Error('Cutover must target the actual order and exact original source');
  const requestHash=preparationHash({action,releaseSha,operator,input});
  const prior=(await db.query("SELECT resource_kind,resource_id,generation,mode,basis->>'requestHash' AS request_hash FROM digital_warehouse_receipt_cutovers WHERE request_id=$1",[approved.requestId])).rows[0];
  if(prior){
   if(prior.request_hash!==requestHash)throw Error('Warehouse cutover request ID was used for another operation');
   await db.query('COMMIT');
   return {...output,replayed:true,requestedGeneration:prior.generation};
  }
  if(output.generation!==approved.expectedGeneration)throw Error('Warehouse cutover generation has changed');
  if(ctx.orderId&&(!(await preparationAdoption(db,input.resource))||!(await new BulkPreparationService(pool).gates(db,ctx.orderId)).parallel))
   throw Error('Order retains its original preparation route; no adopted parallel fabric inspection');
  if((await db.query(`SELECT 1 FROM digital_production_resource_lifecycle WHERE
   ((resource_kind='source' AND resource_id=$1) OR (resource_kind='order' AND resource_id=$2)) AND state<>'active'
   UNION ALL SELECT 1 FROM digital_order_closures WHERE production_order_id=$2 LIMIT 1`,[ctx.sourceId,ctx.orderId])).rowCount)
   throw Error('Archived or paused resource cannot change receipt mode');
  const scopes=state.scopes.map(({key,investment,basisRevision})=>({key,investment,basisRevision}));
  if(!scopes.length||new Set(scopes.map(row=>row.key)).size!==scopes.length||
   preparationHash(scopes)!==preparationHash([...approved.scopes].sort(compare)))throw Error('Whole/shared receipt group or evidence has changed; obtain current approved scope');
  if(action==='safe-read'&&!cutover)throw Error('An inactive group has no safe-read generation');
  if(cutover?.mode==='active'&&action==='activate'&&!warehouseCutoverScopesCurrent(state.view.work,cutover))
   throw Error('Original receipt group keys have changed; keep affected facts on safe-read');
  const mode=action==='activate'?'active':'safe_read',generation=output.generation+1;
  const scopeKeys=(action==='safe-read'?cutover!.scopeKeys:scopes.map(row=>row.key)).slice().sort();
  await db.query(`INSERT INTO digital_warehouse_receipt_cutovers
   (resource_kind,resource_id,generation,mode,scope_keys,request_id,release_sha,operator_label,reason,basis)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[input.resource.kind,input.resource.id,generation,mode,JSON.stringify(scopeKeys),
   approved.requestId,releaseSha,operator,approved.reason,JSON.stringify({requestHash,sourceId:ctx.sourceId,prior:output.generation,scopes})]);
  if(action==='activate'&&ctx.orderId)await refreshPreparationWindows(db,ctx.orderId,'draft-only');
  const next=await observe(db,input.resource);
  await db.query('COMMIT');
  return {...output,generation,mode,windows:next.windows};
 }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}
