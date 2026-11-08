import type {Pool,PoolClient} from 'pg';
import type {DeliveryPo} from '@dx-rework/contracts/delivery-calendar';
import type {TrustedActorContext} from '../tools/repositories.js';
import {DigitalDevelopmentService} from './development-service.js';
import {developmentDocumentRow} from './development-round-repository.js';
import {acceptanceIncludesNative} from '../acceptance-clock/business-time.js';
import {ApplicationError} from '../platform/errors.js';

/** Current-page metadata only. Existing protected attachment handlers retain
 * their original dynamic authorization, ownership and private download intents.
 */
export async function deliveryCalendarImages(database:Pool,db:Pick<Pool|PoolClient,'query'>,actor:TrustedActorContext,rows:readonly DeliveryPo[]):Promise<DeliveryPo[]>{
 const ids=[...new Set(rows.map(row=>row.orderId))];if(!ids.length)return [];
 const records=(await db.query<{production_order_id:string;source_id:string|null;image:string|null;malformed:boolean}>(`SELECT o.production_order_id,o.source_id,
  (SELECT image->>'attachmentId' FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v.document->'images')='array' THEN v.document->'images' ELSE '[]'::jsonb END) WITH ORDINALITY item(image,n)
   WHERE image->>'kind'='款图' AND image->>'attachmentId'~*'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' ORDER BY n LIMIT 1) AS image,
  v.document IS NOT NULL AND jsonb_typeof(v.document->'images') IS DISTINCT FROM 'array' AS malformed
  FROM digital_production_orders o LEFT JOIN digital_instruction_documents head USING(production_order_id)
  LEFT JOIN digital_instruction_versions v ON v.production_order_id=o.production_order_id AND v.version=head.published_version WHERE o.production_order_id=ANY($1::uuid[])`,[ids])).rows;
 const byOrder=new Map<string,Pick<DeliveryPo,'styleImageUrl'|'styleImageState'>>(),sourceCache=new Map<string,Pick<DeliveryPo,'styleImageUrl'|'styleImageState'>>();
 for(const record of records){
  if(record.image){byOrder.set(record.production_order_id,{styleImageUrl:`/api/digital-production/orders/${record.production_order_id}/instruction/attachments/${record.image}`,styleImageState:'available'});continue;}
  if(record.malformed){byOrder.set(record.production_order_id,{styleImageUrl:null,styleImageState:'failed'});continue;}
  let value:Pick<DeliveryPo,'styleImageUrl'|'styleImageState'>={styleImageUrl:null,styleImageState:'empty'};
  if(record.source_id){
   const cached=sourceCache.get(record.source_id);if(cached)value=cached;else{
    try{
     if(!await acceptanceIncludesNative(database,record.source_id))value={styleImageUrl:null,styleImageState:'unavailable'};
     else{
      const client=await database.connect();let document;try{document=await developmentDocumentRow(client,record.source_id);}finally{client.release();}const files=document?.status==='published'?document.document?.files:null;
      const image=Array.isArray(files)?files.find((item:{kind?:string;attachmentId?:string})=>item.kind==='款图'&&typeof item.attachmentId==='string'&&/^[0-9a-f-]{36}$/i.test(item.attachmentId)):undefined;
      if(image){const allowed=await new DigitalDevelopmentService(database,false).canDownload(actor,record.source_id,image.attachmentId);value=allowed?{styleImageUrl:`/api/digital-production/sources/${record.source_id}/development/attachments/${image.attachmentId}`,styleImageState:'available'}:{styleImageUrl:null,styleImageState:'unavailable'};}
     }
    }catch(error){if(error instanceof ApplicationError&&[403,404].includes(error.statusCode))value={styleImageUrl:null,styleImageState:'unavailable'};else throw error;}
    sourceCache.set(record.source_id,value);
   }
  }
  byOrder.set(record.production_order_id,value);
 }
 return rows.map(row=>({...row,...byOrder.get(row.orderId)??{styleImageUrl:null,styleImageState:'unavailable' as const}}));
}
