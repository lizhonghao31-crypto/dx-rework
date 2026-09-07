import {randomUUID} from 'node:crypto';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import type {Pool} from 'pg';
import {DiagnosticsResponseSchema,WorkAnalysisQuerySchema,type DiagnosticsResponse} from '@dx-rework/contracts';
import {ApplicationError} from './errors.js';
// Exact server route templates only. Never inspect raw URLs, IDs, headers or bodies.
export const diagnosticOperations:Readonly<Record<string,string>>={
 'POST /tools/attachments/upload-intents':'attachment_intent','POST /tools/attachments/:attachmentId/finalize':'attachment_finalize',
 'POST /samples':'sample_create','POST /samples/batch':'sample_batch_create',
 'POST /master-data/suppliers':'supplier_create','POST /master-data/suppliers/:supplierId/versions':'supplier_revision',
 'POST /sourcing/cases':'sourcing_create','POST /sourcing/cases/:sourcingCaseId/ie-quotes':'sourcing_ie_quote',
 'POST /sourcing/cases/:sourcingCaseId/management-decisions':'sourcing_management_decision','POST /sourcing/cases/:sourcingCaseId/owner-decisions':'sourcing_owner_decision',
 'POST /production-reporting/:id/reports':'production_report','POST /production-reporting/:id/reports/:reportId/corrections':'production_correction',
 'POST /receiving/receipts':'receiving_record','POST /receiving/repeat-receipts':'receiving_repeat',
 'POST /receiving/receipts/:receiptId/corrections':'receiving_correction',
 'POST /receiving/batches/:receivingBatchId/packing-revisions':'packing_revision',
 'POST /receiving/batches/:receivingBatchId/difference-resolutions':'difference_resolution',
};
const codes=new Set(['VALIDATION_ERROR','FORBIDDEN','NO_BUSINESS_ROLE','UNAUTHORIZED','NOT_FOUND','CONFLICT','VERSION_CONFLICT','INTERNAL_ERROR','IDEMPOTENCY_CONFLICT','ATTACHMENT_NOT_READY','ATTACHMENT_UPLOAD_INCOMPLETE']);
export function safeDiagnosticCode(value:unknown,status:number):string {return status<400?'OK':status>=500?'INTERNAL_ERROR':typeof value==='string'&&codes.has(value)?value:'UNCLASSIFIED';}
export function diagnosticOutcome(status:number):'success'|'permission'|'validation'|'technical'{return status>=500?'technical':status===401||status===403?'permission':status>=400?'validation':'success';}
export type DiagnosticRecord=Readonly<{operation:string;status:number;code:string;replayed:boolean}>;
export function registerOperationDiagnostics(app:FastifyInstance,record:(row:DiagnosticRecord)=>Promise<void>):void{
 const errors=new WeakMap<FastifyRequest,unknown>();
 app.addHook('onError',async(request,_reply,error)=>{errors.set(request,safeDiagnosticCode(error.code,Number(error.statusCode??500)));});
 app.addHook('onResponse',async(request,reply)=>{
  const operation=diagnosticOperations[`${request.method} ${request.routeOptions.url??''}`],status=reply.statusCode;
  if(!operation||status<200||status>=300&&status<400)return;
  // Header comes from the business handler's confirmed reused result, not a client claim.
  const row={operation,status,code:safeDiagnosticCode(errors.get(request),status),replayed:status<300&&reply.getHeader('idempotency-replayed')==='true'};
  try{await record(row);}catch{request.log.warn({diagnosticWriteFailed:true},'Operation diagnostic unavailable');}
 });
}
export async function recordOperationDiagnostic(db:Pool,row:DiagnosticRecord):Promise<void>{
 if(!Object.values(diagnosticOperations).includes(row.operation))return;
 await db.query(`INSERT INTO work_operation_diagnostics(diagnostic_id,operation,http_status,outcome,error_code,replayed) VALUES($1,$2,$3,$4,$5,$6)`,[randomUUID(),row.operation,row.status,diagnosticOutcome(row.status),safeDiagnosticCode(row.code,row.status),row.status<300&&row.replayed]);
}
// Both sides must contain a whitelisted field; absent audit facts are not fabricated as edits.
export const DIAGNOSTIC_REVISIONS_SQL=`SELECT action,field,count(*)::text count FROM operation_events
 CROSS JOIN unnest(ARRAY['styleNo','color','quantity','deliveryDate','lineItems','linePrices','supplierName','supplierType','active','actualQuantity','documentQuantity']) field
 WHERE action=ANY($1::text[]) AND before_state ? field AND after_state ? field AND before_state->field IS DISTINCT FROM after_state->field
 AND ($2::date IS NULL OR created_at >= $2::date::timestamp AT TIME ZONE 'Asia/Shanghai')
 AND ($3::date IS NULL OR created_at < ($3::date+1)::timestamp AT TIME ZONE 'Asia/Shanghai')
 GROUP BY action,field ORDER BY count(*) DESC,action,field`;
const revisionActions=['sourcing.ie_price.quote','sourcing.management_decision.record','master_data.supplier.revise','receiving.receipt.correct','receiving.batch.correct','sourcing.production.correct'];
export async function readOperationDiagnostics(db:Pool,input:unknown):Promise<DiagnosticsResponse>{
 const parsed=WorkAnalysisQuerySchema.safeParse(input);if(!parsed.success||!['all','success','validation','permission','technical'].includes(parsed.data.group))throw new ApplicationError('VALIDATION_ERROR','诊断筛选无效',400);
 const filters=parsed.data,client=await db.connect();
 try{await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');const clock=await client.query<{now:Date;since:Date|null}>('SELECT CURRENT_TIMESTAMP now,(SELECT min(recorded_at) FROM work_operation_diagnostics) since');
 const result=await client.query<{operation:string;outcome:string;code:string;count:string;replayedCount:string;lastAt:Date}>(`SELECT operation,outcome,error_code code,count(*)::text count,count(*) FILTER(WHERE replayed)::text AS "replayedCount",max(recorded_at) AS "lastAt" FROM work_operation_diagnostics
 WHERE ($1='' OR operation ILIKE '%'||$1||'%') AND ($2='all' OR outcome=$2)
 AND ($3::date IS NULL OR recorded_at >= $3::date::timestamp AT TIME ZONE 'Asia/Shanghai')
 AND ($4::date IS NULL OR recorded_at < ($4::date+1)::timestamp AT TIME ZONE 'Asia/Shanghai')
 GROUP BY operation,outcome,error_code ORDER BY count(*) DESC,operation,outcome,error_code`,[filters.q,filters.group,filters.from??null,filters.to??null]);
 // Revision facts have a separate explicitly labelled audit/date scope, not failed-request outcomes.
 const revisions=await client.query<{action:string;field:string;count:string}>(DIAGNOSTIC_REVISIONS_SQL,[revisionActions,filters.from??null,filters.to??null]);
 await client.query('COMMIT');return DiagnosticsResponseSchema.parse({asOf:clock.rows[0]!.now.toISOString(),recordingSince:clock.rows[0]!.since?.toISOString()??null,filters,total:result.rows.length,recordCount:result.rows.reduce((sum,r)=>sum+BigInt(r.count),0n).toString(),groups:result.rows.slice((filters.page-1)*15,filters.page*15).map(r=>({...r,lastAt:r.lastAt.toISOString()})),revisions:revisions.rows});
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
