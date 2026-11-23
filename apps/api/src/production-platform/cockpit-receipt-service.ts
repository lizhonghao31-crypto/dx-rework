import type {Pool,PoolClient} from 'pg';
import type {TrustedActorContext} from '../tools/repositories.js';
import {readReceivingDocumentHistory} from '../receiving/receiving-document-history.js';
import {readNativeReceivingTotals} from '../receiving/native-receiving-totals.js';
import {DigitalProductionAccessPolicy,digitalNotFound} from './access-policy.js';
import {canOpenOrderReceiving} from './receiving-summary.js';
import {journeyCutScopes} from './journey-cut-scopes.js';
import {readCockpitOrderReceipts} from './cockpit-receipt-facts.js';

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

  async read(actor:TrustedActorContext,orderId:string,includeDocumentBindings=false){
    return this.inSnapshot(async db=>{
      // Same order authorization and receiving eligibility as the original closure view.
      if(!canOpenOrderReceiving(actor.actorRoles)) digitalNotFound();
      await new DigitalProductionAccessPolicy(db).assert(actor,'order',orderId,'technical');
      const poLines=(await db.query<{lineId:string;poNumber:string|null;color:string;demand:number}>(`
        SELECT p.line_id AS "lineId",p.po_number AS "poNumber",p.color,coalesce(sum(s.quantity),0)::int AS demand
        FROM digital_production_po_lines p LEFT JOIN digital_production_po_sizes s ON s.line_id=p.line_id
        WHERE p.production_order_id=$1 GROUP BY p.line_id ORDER BY p.position,p.line_id`,[orderId])).rows;
      const cutIdsByLine=new Map((await journeyCutScopes(db,orderId)).flatMap(scope=>
        scope.status==='verified'?[[scope.lineId,scope.cuts[0]!.cuttingOrderId] as const]:[]));
      const cutIds=[...cutIdsByLine.values()];
      const native=new Map((await readNativeReceivingTotals(db,cutIds)).map(row=>[row.group_key,row]));
      const receipts=await readCockpitOrderReceipts(db,orderId);
      const batchIds=(await db.query<{id:string}>(`
        SELECT receiving_batch_id AS id FROM receiving_batches WHERE deleted_at IS NULL
          AND (receiving_batch_id=ANY($1::uuid[]) OR cutting_order_id=ANY($2::uuid[]))
        ORDER BY receiving_batch_id`,[[...new Set(receipts.map(receipt=>receipt.batchId))],cutIds])).rows.map(row=>row.id);
      const history=batchIds.length?await readReceivingDocumentHistory(db,batchIds):null;
      const documents=history?.files.filter(file=>file.status==='ready'&&file.retiredAt===null)
        .map(({id,filename,entityId})=>({id,filename,...(includeDocumentBindings?{entityId}:{})}))??[];
      const lines=poLines.map(line=>{
        const own=receipts.filter(row=>row.lineId===line.lineId);
        const aggregate=native.get(`cut:${cutIdsByLine.get(line.lineId)}`);
        const received=numberOrNull(aggregate?.current_actual_quantity)??(own.length?own.reduce((n,row)=>n+row.actualQuantity,0):null);
        const receiptCount=numberOrNull(aggregate?.receipt_count)??own.length;
        const status=!receiptCount?'暂无收货记录':received==null?'实收待核':received<line.demand?'部分收货':'已收齐';
        return {lineId:line.lineId,poNumber:line.poNumber,color:line.color,
          demand:line.demand,received,receiptCount,status,documentQuantity:numberOrNull(aggregate?.document_quantity),
          defectiveQuantity:numberOrNull(aggregate?.current_defective_quantity)??(own.length?own.reduce((n,row)=>n+row.defectiveQuantity,0):null),
          packingQuantity:numberOrNull(aggregate?.packing_quantity),
          receivingResolution:aggregate?.receiving_resolution??null,packingResolution:aggregate?.packing_resolution??null,
          records:own.map(({receiptId,receivedAt,receivedDate,actualQuantity,defectiveQuantity,batchId})=>({
            receiptId,receivedAt,receivedDate,actualQuantity,defectiveQuantity,batchId
          }))};
      });
      const demand=lines.length?lines.reduce((n,row)=>n+row.demand,0):null;
      const observed=lines.some(row=>row.received!==null);
      const received=observed?lines.reduce((n,row)=>n+(row.received??0),0):null;
      const complete=demand!==null&&received!==null&&lines.every(row=>row.received!==null||row.receiptCount===0);
      // Extra units in one PO never satisfy the obligation of another PO.
      const differences=complete?lines.reduce((totals,row)=>{
        const difference=(row.received??0)-row.demand;
        return {remaining:totals.remaining+Math.max(0,-difference),excess:totals.excess+Math.max(0,difference)};
      },{remaining:0,excess:0}):null;
      const status=!observed?'暂无收货记录':!differences?'数量待核':differences.remaining>0?'部分收货':'已收齐';
      const closed=Boolean((await db.query(
        'SELECT 1 FROM digital_order_closures WHERE production_order_id=$1 LIMIT 1',[orderId])).rowCount);
      return {orderId,status,closed,totals:{demand,received,remaining:differences?.remaining??null,excess:differences?.excess??null},
        lines,history:history?{receipts:history.receipts,corrections:history.corrections,packing:history.packing,resolutions:history.resolutions}:null,documents};
    });
  }
}
