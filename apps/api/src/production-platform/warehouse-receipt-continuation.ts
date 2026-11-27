import type {PreparationMaterialRecord,PreparationResource,WarehouseReceiptContinuation} from '@dx-rework/contracts/production-readiness';
import type {PreparationDB} from './preparation-material-repository.js';
import {ApplicationError} from '../platform/errors.js';

const stream=(resource:PreparationResource)=>`preparation:${resource.kind}:${resource.id}:`;
const pendingName=(resource:PreparationResource)=>stream(resource)+'fabric-receipt-pending';
export const originalReceiptCommand=(resource:PreparationResource)=>stream(resource)+'record';
const conflict=(message:string):never=>{throw new ApplicationError('CONFLICT',message,409);};
type PendingRow={payload_hash:string;response:{resource:PreparationResource;input:PreparationMaterialRecord}};

export async function preserveLegacyWarehouseReceipt(db:PreparationDB,actorId:string,resource:PreparationResource,key:string,hash:string,input:PreparationMaterialRecord){
 const pending=(await db.query<PendingRow>(
  'SELECT payload_hash,response FROM digital_production_commands WHERE actor_id=$1 AND command=$2 AND key=$3',[actorId,pendingName(resource),key])).rows[0];
 if(pending&&pending.payload_hash!==hash)conflict('操作标识已用于不同原收布内容');
 if(!pending)await db.query('INSERT INTO digital_production_commands(actor_id,command,key,payload_hash,response) VALUES($1,$2,$3,$4,$5)',
  [actorId,pendingName(resource),key,hash,JSON.stringify({resource,input})]);
 return {resource,key};
}

export async function pendingLegacyWarehouseReceipts(db:PreparationDB,actorId:string,resources:PreparationResource[]):Promise<WarehouseReceiptContinuation[]>{
 return (await db.query<{key:string;response:PendingRow['response']}>(`SELECT p.key,p.response
  FROM digital_production_commands p
  WHERE p.actor_id=$1 AND p.command=ANY($2::text[]) AND NOT EXISTS(
   SELECT 1 FROM digital_production_commands done WHERE done.actor_id=p.actor_id AND done.key=p.key
    AND done.command=replace(p.command,':fabric-receipt-pending',':record'))
  ORDER BY p.created_at DESC,p.key LIMIT 25`,[actorId,resources.map(pendingName)])).rows.map(row=>({...row.response,key:row.key}));
}

export async function pendingWarehouseReceiptOrigin(db:PreparationDB,actorId:string,resource:PreparationResource,key:string){
 const origin=(await db.query<PendingRow>(
  'SELECT payload_hash,response FROM digital_production_commands WHERE actor_id=$1 AND command=$2 AND key=$3',[actorId,pendingName(resource),key])).rows[0];
 if(!origin) return conflict('原未过账输入不存在或不在本人授权范围');
 const prior=(await db.query('SELECT 1 FROM digital_production_commands WHERE actor_id=$1 AND command=$2 AND key=$3',
  [actorId,originalReceiptCommand(resource),key])).rowCount;
 if(prior)conflict('该原提交已办理，请读取当前原批，不要重复登记');
 return {resource,key,hash:origin.payload_hash,original:origin.response.input};
}
