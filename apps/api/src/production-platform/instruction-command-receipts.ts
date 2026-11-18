import {createHash} from 'node:crypto';
import type {Pool} from 'pg';
import {InstructionReceiptKeySchema,InstructionSaveReceiptSchema,PoCustomerDecisionReceiptSchema} from '@dx-rework/contracts/production-instruction';
import type {TrustedActorContext} from '../tools/repositories.js';
import {DigitalProductionAccessPolicy} from './access-policy.js';

/** Fixed command namespaces, same authorized read-only RR snapshot. Never
 * call command/save/decide or require the initiating actor to retain write. */
async function ownCommand(pool:Pool,actor:TrustedActorContext,id:string,key:string,command:string){
 InstructionReceiptKeySchema.parse(key);
 const db=await pool.connect();
 try{
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await new DigitalProductionAccessPolicy(db).assert(actor,'order',id,'technical');
  const row=(await db.query('SELECT payload_hash,response FROM digital_production_commands WHERE actor_id=$1 AND command=$2 AND key=$3',[actor.actorId,command,key])).rows[0];
  await db.query('COMMIT');return row as {payload_hash:string;response:unknown}|undefined;
 }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}
export async function instructionSaveReceipt(pool:Pool,actor:TrustedActorContext,id:string,key:string){
 const own={orderId:id,actorId:actor.actorId,key,action:'save' as const},row=await ownCommand(pool,actor,id,key,`instruction:${id}:save`);
 const response=row?.response as {order?:{productionOrderId?:unknown;version?:unknown};version?:unknown;sourceRound?:unknown}|undefined;
 const result=InstructionSaveReceiptSchema.safeParse({status:'completed',...own,payloadHash:row?.payload_hash,savedVersion:response?.version,orderVersion:response?.order?.version,sourceRound:response?.sourceRound});
 return row&&response?.order?.productionOrderId===id&&result.success?result.data:InstructionSaveReceiptSchema.parse({status:'unconfirmed',...own});
}
export async function poCustomerDecisionReceipt(pool:Pool,actor:TrustedActorContext,id:string,requestId:string,approved:boolean,key:string){
 const own={orderId:id,actorId:actor.actorId,key,action:'po_customer_decision' as const,requestId,approved},row=await ownCommand(pool,actor,id,key,`po-customer:${id}:decision`);
 // This namespace's original normalized input contains exactly these fields.
 const hash=createHash('sha256').update(JSON.stringify({requestId,approved})).digest('hex');
 const response=row?.response as {requestId?:unknown;approved?:unknown}|undefined;
 return row&&row.payload_hash===hash&&response?.requestId===requestId&&response.approved===approved
  ?PoCustomerDecisionReceiptSchema.parse({status:'completed',...own,payloadHash:hash})
  :PoCustomerDecisionReceiptSchema.parse({status:'unconfirmed',...own});
}
