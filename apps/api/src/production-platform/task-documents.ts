import type {PoolClient} from 'pg';
import type {TrustedActorContext} from '../tools/repositories.js';
import type {DigitalTaskDocuments} from '@dx-rework/contracts/digital-production-tasks';
import {DigitalProductionAccessPolicy,digitalNotFound} from './access-policy.js';
import {developmentDocumentRow} from './development-round-repository.js';

/** Document references only. Every reader retains its own original authorization. */
export async function taskDocuments(db:PoolClient,actor:TrustedActorContext,id:string):Promise<DigitalTaskDocuments>{
 const policy=new DigitalProductionAccessPolicy(db);await policy.assert(actor,'task',id,'technical');
 const task=(await db.query('SELECT t.route_version,a.source_id,a.production_order_id FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) WHERE task_id=$1',[id])).rows[0]??digitalNotFound();
 const result:DigitalTaskDocuments={development:{state:'unavailable'},instruction:{state:'not_applicable'},budget:{state:'not_applicable'}};
 // The authorized task above belongs to this exact source, matching the original
 // development reader's visible-source-task fallback without granting budget access.
 if(task.source_id){
  const row=await developmentDocumentRow(db,task.source_id,task.route_version);
  result.development=row?.status==='published'?{state:'published',id:task.source_id,version:task.route_version,label:'本次采用'}:{state:row?'draft':'missing'};
 }
 const orderId=task.production_order_id??(task.source_id?(await db.query('SELECT production_order_id FROM digital_production_orders WHERE source_id=$1',[task.source_id])).rows[0]?.production_order_id:null);
 if(!orderId)return result;
 result.instruction={state:'unavailable'};result.budget={state:'unavailable'};
 if(await policy.allowed(actor,'order',orderId,'technical')){
  const row=(await db.query('SELECT v.version FROM digital_instruction_versions v JOIN digital_instruction_documents d USING(production_order_id) WHERE v.production_order_id=$1 AND v.version=d.published_version AND ($2::boolean OR v.source_round=$3)',[orderId,!task.source_id,task.route_version])).rows[0];
  const draft=!row&&(await db.query('SELECT 1 FROM digital_instruction_documents WHERE production_order_id=$1 AND version IS DISTINCT FROM published_version AND ($2::boolean OR source_round=$3)',[orderId,!task.source_id,task.route_version])).rowCount;
  result.instruction=row?{state:'published',id:orderId,version:row.version,label:'当前有效'}:{state:draft?'draft':'missing'};
 }
 if(await policy.allowed(actor,'order',orderId,'budget')){
  const row=(await db.query('SELECT version FROM digital_budget_versions WHERE production_order_id=$1 ORDER BY version DESC LIMIT 1',[orderId])).rows[0];
  const draft=!row&&(await db.query('SELECT 1 FROM digital_budget_documents WHERE production_order_id=$1',[orderId])).rowCount;
  result.budget=row?{state:'published',id:orderId,version:row.version,label:'当前有效'}:{state:draft?'draft':'missing'};
 }
 return result;
}
