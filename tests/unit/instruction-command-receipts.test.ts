import {randomUUID,createHash} from 'node:crypto';
import type {Pool} from 'pg';
import {afterEach,expect,it,vi} from 'vitest';
import {instructionSaveReceipt,poCustomerDecisionReceipt} from '../../apps/api/src/production-platform/instruction-command-receipts.js';
import {ProductionInstructionService} from '../../apps/api/src/production-platform/production-instruction-service.js';
import {PoCustomerDateService} from '../../apps/api/src/production-platform/po-customer-date-service.js';
import {DigitalProductionAccessPolicy} from '../../apps/api/src/production-platform/access-policy.js';
import {ApplicationError} from '../../apps/api/src/platform/errors.js';
import type {TrustedActorContext} from '../../apps/api/src/tools/repositories.js';

afterEach(()=>vi.restoreAllMocks());
function fixture(){
 const actor:TrustedActorContext={actorId:randomUUID(),actorRoles:['order_merchandiser'],authorizationCapability:'digital_production:view',requestId:'TEST own receipt'};
 const id=randomUUID(),requestId=randomUUID(),key='TEST-original-key',rows=new Map<string,unknown>(),statements:string[]=[];
 const query=vi.fn(async(sql:string,args:unknown[]=[])=>{
  statements.push(sql);
  if(['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY','COMMIT','ROLLBACK'].includes(sql))return {rows:[],rowCount:0};
  if(sql==='SELECT payload_hash,response FROM digital_production_commands WHERE actor_id=$1 AND command=$2 AND key=$3'){
   const found=rows.get(JSON.stringify(args));return {rows:found?[found]:[],rowCount:found?1:0};
  }
  throw Error('Unexpected receipt query '+sql);
 });
 const release=vi.fn(),connect=vi.fn(async()=>({query,release})),pool={connect} as unknown as Pool;
 const authorize=vi.spyOn(DigitalProductionAccessPolicy.prototype,'assert').mockResolvedValue(undefined);
 const store=(command:string,response:unknown,hash='a'.repeat(64),who=actor.actorId,originalKey=key)=>rows.set(JSON.stringify([who,command,originalKey]),{payload_hash:hash,response});
 return {actor,id,requestId,key,rows,query,statements,release,connect,pool,authorize,store};
}
it('reads only the initiating actor original save under current read authorization, omitting all historical body',async()=>{
 const f=fixture();f.store(`instruction:${f.id}:save`,{order:{productionOrderId:f.id,version:7,price:'TEST private price'},version:4,sourceRound:2,document:{remarks:'TEST private historical document'}});
 expect(await instructionSaveReceipt(f.pool,f.actor,f.id,f.key)).toEqual({status:'completed',action:'save',actorId:f.actor.actorId,orderId:f.id,key:f.key,payloadHash:'a'.repeat(64),savedVersion:4,orderVersion:7,sourceRound:2});
 expect(f.authorize).toHaveBeenCalledWith(f.actor,'order',f.id,'technical');expect(f.statements).toEqual(['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY','SELECT payload_hash,response FROM digital_production_commands WHERE actor_id=$1 AND command=$2 AND key=$3','COMMIT']);
 expect(f.release).toHaveBeenCalledOnce();
 const other={...f.actor,actorId:randomUUID()};expect(await instructionSaveReceipt(f.pool,other,f.id,f.key)).toMatchObject({status:'unconfirmed',actorId:other.actorId});
 expect(await instructionSaveReceipt(f.pool,f.actor,randomUUID(),f.key)).toMatchObject({status:'unconfirmed'});
 expect(await instructionSaveReceipt(f.pool,f.actor,f.id,'different-key')).toMatchObject({status:'unconfirmed'});
});
it('does not borrow publish or malformed/mismatched saved response and rejects bad keys before connecting',async()=>{
 const f=fixture();f.store(`instruction:${f.id}:publish`,{order:{productionOrderId:f.id,version:7},version:4,sourceRound:null});
 expect(await instructionSaveReceipt(f.pool,f.actor,f.id,f.key)).toMatchObject({status:'unconfirmed'});
 for(const response of [null,{order:{productionOrderId:randomUUID(),version:7},version:4,sourceRound:null},{order:{productionOrderId:f.id,version:7},version:0,sourceRound:null}]){
  f.store(`instruction:${f.id}:save`,response);expect(await instructionSaveReceipt(f.pool,f.actor,f.id,f.key)).toMatchObject({status:'unconfirmed'});
 }
 const before=f.connect.mock.calls.length;await expect(instructionSaveReceipt(f.pool,f.actor,f.id,'?bad-key')).rejects.toThrow();expect(f.connect.mock.calls).toHaveLength(before);
});
it('binds decision actor/order/request/direction/key and original two-field hash, independently of save namespace',async()=>{
 const f=fixture(),body={requestId:f.requestId,approved:true},hash=createHash('sha256').update(JSON.stringify(body)).digest('hex');
 f.store(`po-customer:${f.id}:decision`,body,hash);expect(await poCustomerDecisionReceipt(f.pool,f.actor,f.id,f.requestId,true,f.key)).toMatchObject({status:'completed',action:'po_customer_decision',payloadHash:hash,...body});
 expect(await poCustomerDecisionReceipt(f.pool,f.actor,f.id,f.requestId,false,f.key)).toMatchObject({status:'unconfirmed'});expect(await poCustomerDecisionReceipt(f.pool,f.actor,f.id,randomUUID(),true,f.key)).toMatchObject({status:'unconfirmed'});
 f.store(`po-customer:${f.id}:decision`,body,'b'.repeat(64));expect(await poCustomerDecisionReceipt(f.pool,f.actor,f.id,f.requestId,true,f.key)).toMatchObject({status:'unconfirmed'});
 expect(await instructionSaveReceipt(f.pool,f.actor,f.id,f.key)).toMatchObject({status:'unconfirmed'});
});
it('denies lost read permission before touching a command, with no write or decision replay',async()=>{
 const f=fixture();f.authorize.mockRejectedValue(new ApplicationError('FORBIDDEN','TEST revoked current read',403));
 await expect(poCustomerDecisionReceipt(f.pool,f.actor,f.id,f.requestId,true,f.key)).rejects.toMatchObject({statusCode:403});expect(f.statements).toEqual(['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY','ROLLBACK']);expect(f.release).toHaveBeenCalledOnce();
});
it.each([403,404,409,500])('distinguishes committed decision read failure %s from original transaction rejection',async(status)=>{
 const f=fixture(),service=new ProductionInstructionService(f.pool,true),cause=new ApplicationError('TEST_READ','TEST post-commit read',status);
 const decide=vi.spyOn(PoCustomerDateService.prototype,'decide').mockResolvedValue(undefined);vi.spyOn(service,'read').mockRejectedValue(cause);
 await expect(service.decideDate(f.actor,f.id,f.requestId,true,f.key)).rejects.toMatchObject({code:'PO_CUSTOMER_DECISION_READ_UNAVAILABLE',statusCode:503,cause});
 decide.mockRejectedValue(new ApplicationError('FORBIDDEN','TEST original transaction rejected',403));
 await expect(service.decideDate(f.actor,f.id,f.requestId,true,f.key)).rejects.toMatchObject({code:'FORBIDDEN',statusCode:403});
});
