import type {Pool,PoolClient} from 'pg';
import type {TrustedActorContext} from '../tools/repositories.js';
import {readReceivingDocumentHistory} from '../receiving/receiving-document-history.js';
import {readNativeReceivingTotals} from '../receiving/native-receiving-totals.js';
import {readCockpitReceiptScope} from './cockpit-receipt-scope.js';
import {authorizedReceivingHistoryBatches,readCockpitScopedReceipts} from './cockpit-receipt-facts.js';

const numberOrNull = (value: unknown) => value == null ? null : Number(value);

export class CockpitReceiptService {
  constructor(private readonly database:Pool){}

  private async inSnapshot<T>(read:(db:PoolClient)=>Promise<T>):Promise<T>{
    const db=await this.database.connect();
    try{
      await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const result=await read(db);
      await db.query('COMMIT');
      return result;
    }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
  }

  private async readScope(db:PoolClient,actor:TrustedActorContext,orderId:string){
    const scope=await readCockpitReceiptScope(db,actor,orderId);
    const receipts=await readCockpitScopedReceipts(db,orderId,scope.scope==='whole',scope.lines);
    const batches=await authorizedReceivingHistoryBatches(db,receipts);
    return {scope,receipts,batches};
  }

  private async readFiles(db:PoolClient,batches:readonly string[],attachmentId?:string){
    if(!batches.length)return [];
    return (await db.query<{id:string;filename:string;mimeType:string;entityType:string;entityId:string}>(`
      SELECT a.attachment_id AS id,a.original_filename AS filename,a.mime_type AS "mimeType",
        a.entity_type AS "entityType",a.entity_id AS "entityId" FROM attachments a
      WHERE a.status='ready' AND a.mime_type LIKE 'image/%' AND ($2::uuid IS NULL OR a.attachment_id=$2)
        AND NOT EXISTS(SELECT 1 FROM receiving_attachment_retirements retired WHERE retired.attachment_id=a.attachment_id)
        AND (a.entity_type='receiving_batch' AND a.entity_id=ANY($1::text[])
          OR a.entity_type='receiving_difference_resolution' AND EXISTS(
            SELECT 1 FROM receiving_difference_resolutions resolution
            WHERE resolution.resolution_id::text=a.entity_id AND resolution.receiving_batch_id::text=ANY($1::text[])
          ))
      ORDER BY a.created_at,a.attachment_id`,[batches,attachmentId??null])).rows;
  }

  async attachment(actor:TrustedActorContext,orderId:string,attachmentId:string){
    return this.inSnapshot(async db=>{
      const {batches}=await this.readScope(db,actor,orderId);
      return (await this.readFiles(db,batches,attachmentId))[0]??null;
    });
  }

  async read(actor:TrustedActorContext,orderId:string){
    return this.inSnapshot(async db=>{
      const {scope,receipts,batches}=await this.readScope(db,actor,orderId);
      const cutIds=scope.lines.flatMap(line=>line.cutId?[line.cutId]:[]);
      // Native aggregates include all storage facts in a cut. Only use one
      // when each active batch in that group is independently authorized.
      const verified=cutIds.length?(await db.query<{id:string}>(`
        SELECT requested.id FROM unnest($1::uuid[]) requested(id)
        WHERE NOT EXISTS(
          SELECT 1 FROM receiving_batches batch
          JOIN receiving_receipts receipt USING(receiving_batch_id)
          WHERE batch.cutting_order_id=requested.id AND batch.deleted_at IS NULL
            AND NOT (batch.receiving_batch_id=ANY($2::uuid[]))
        )`,[cutIds,batches])).rows.map(row=>row.id):[];
      const totals=await readNativeReceivingTotals(db,verified);
      const native=new Map(totals.map(row=>[row.group_key,row]));
      const history=batches.length?await readReceivingDocumentHistory(db,batches,{includeFiles:false}):null;
      const documents=(await this.readFiles(db,batches)).map(({id,filename,mimeType})=>({id,filename,image:mimeType.startsWith('image/')}));
      const lines=scope.lines.map(line=>{
        const own=receipts.filter(row=>row.lineId===line.lineId);
        const aggregate=line.cutId?native.get(`cut:${line.cutId}`):undefined;
        const received=numberOrNull(aggregate?.current_actual_quantity)??(own.length?own.reduce((n,row)=>n+row.actualQuantity,0):null);
        const receiptCount=numberOrNull(aggregate?.receipt_count)??own.length;
        const status=!receiptCount?'暂无收货记录':line.demand==null?'需求待核':received==null?'实收待核':
          received<line.demand?'部分收货':line.verifiedWholePo?'已收齐':'可见数量已达到';
        return {lineId:line.lineId,poNumber:line.poNumber,color:line.color,scope:line.verifiedWholePo?'whole' as const:'visible' as const,
          demand:line.demand,received,receiptCount,status,documentQuantity:numberOrNull(aggregate?.document_quantity),
          defectiveQuantity:numberOrNull(aggregate?.current_defective_quantity)??(own.length?own.reduce((n,row)=>n+row.defectiveQuantity,0):null),
          packingQuantity:numberOrNull(aggregate?.packing_quantity),
          receivingResolution:aggregate?.receiving_resolution??null,packingResolution:aggregate?.packing_resolution??null,
          records:own.map(({receiptId,receivedAt,receivedDate,actualQuantity,defectiveQuantity,batchId})=>({
            receiptId,receivedAt,receivedDate,actualQuantity,defectiveQuantity,batchId
          }))};
      });
      const demand=lines.length&&lines.every(row=>row.demand!=null)?lines.reduce((n,row)=>n+row.demand!,0):null;
      const observed=lines.some(row=>row.received!==null);
      const received=observed?lines.reduce((n,row)=>n+(row.received??0),0):null;
      const complete=demand!==null&&received!==null&&lines.every(row=>row.received!==null||row.scope==='whole'&&row.receiptCount===0);
      // Extra units in one PO never satisfy the obligation of another PO.
      const differences=complete?lines.reduce((totals,row)=>{
        const difference=(row.received??0)-row.demand!;
        return {remaining:totals.remaining+Math.max(0,-difference),excess:totals.excess+Math.max(0,difference)};
      },{remaining:0,excess:0}):null;
      const status=!observed?'暂无收货记录':!differences?'数量待核':differences.remaining>0?'部分收货':scope.scope==='whole'?'已收齐':'可见数量已达到';
      const closed=scope.scope==='whole'&&Boolean((await db.query(
        'SELECT 1 FROM digital_order_closures WHERE production_order_id=$1 LIMIT 1',[orderId])).rowCount);
      return {orderId,scope:scope.scope,status,closed,totals:{demand,received,remaining:differences?.remaining??null,excess:differences?.excess??null},
        lines,history:history?{receipts:history.receipts,corrections:history.corrections,packing:history.packing,resolutions:history.resolutions}:null,documents};
    });
  }
}
