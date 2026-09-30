import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { CreateExportJob, ExportJobResponse } from "@dx-rework/contracts";
import { sanitizeOperationalError } from "@dx-rework/domain";
import { assertBusinessExportAllowed } from "../access/export-authority.js";
import { ApplicationError } from "../platform/errors.js";
import type { TrustedActorContext } from "./repositories.js";
import { OperationEventRepository } from "./repositories.js";

type Row={export_job_id:string;requested_by:string;export_type:string;filters:Record<string,unknown>;status:"pending"|"running"|"succeeded"|"failed";result_attachment_id:string|null;claim_token:string|null;created_at:Date};

const validateClaimOptions=(limit:number,leaseSeconds:number):void=>{
 if(!Number.isInteger(limit)||limit<1||limit>100)throw new ApplicationError("VALIDATION_ERROR","Claim limit must be between 1 and 100",400);
 if(!Number.isInteger(leaseSeconds)||leaseSeconds<30||leaseSeconds>3600)throw new ApplicationError("VALIDATION_ERROR","Claim lease must be between 30 and 3600 seconds",400);
};

export class ExportJobService{
 constructor(private readonly pool:Pool,private readonly events=new OperationEventRepository()){}
 async create(actor:TrustedActorContext,input:CreateExportJob):Promise<ExportJobResponse>{assertBusinessExportAllowed(actor.actorRoles,"tools:export");const id=randomUUID();const client=await this.pool.connect();try{await client.query("BEGIN");const result=await client.query<Row>(`INSERT INTO export_jobs(export_job_id,requested_by,export_type,filters,idempotency_key) VALUES($1,$2,$3,$4,$5) ON CONFLICT(requested_by,export_type,idempotency_key) DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key WHERE export_jobs.filters=EXCLUDED.filters RETURNING *`,[id,actor.actorId,input.exportType,input.filters,input.idempotencyKey]);const row=result.rows[0];if(!row)throw new ApplicationError("IDEMPOTENCY_CONFLICT","Export idempotency key was used with different filters",409);if(row.export_job_id===id)await this.events.append(client,actor,{action:"export.created",entityType:"export_job",entityId:id,after:{exportType:input.exportType}});await client.query("COMMIT");return this.dto(row);}catch(e){await client.query("ROLLBACK");throw e;}finally{client.release();}}
 async query(requestedBy:string,id:string):Promise<ExportJobResponse>{const r=await this.pool.query<Row>(`SELECT * FROM export_jobs WHERE export_job_id=$1`,[id]);const row=r.rows[0];if(!row)throw new ApplicationError("NOT_FOUND","Export job not found",404);if(row.requested_by!==requestedBy)throw new ApplicationError("FORBIDDEN","Export job access denied",403);return this.dto(row);}
 async isOwnedBy(requestedBy:string,id:string):Promise<boolean>{const r=await this.pool.query(`SELECT 1 FROM export_jobs WHERE export_job_id=$1 AND requested_by=$2`,[id,requestedBy]);return r.rowCount===1;}
 async claim(client:Pick<PoolClient,"query">,limit=1,leaseSeconds=300):Promise<Row[]>{validateClaimOptions(limit,leaseSeconds);const claimToken=randomUUID();const r=await client.query<Row>(`WITH candidates AS (SELECT export_job_id FROM export_jobs WHERE status='pending' OR (status='running' AND claimed_at <= CURRENT_TIMESTAMP - ($2 * interval '1 second')) ORDER BY COALESCE(claimed_at,created_at),created_at FOR UPDATE SKIP LOCKED LIMIT $1) UPDATE export_jobs j SET status='running',claimed_at=CURRENT_TIMESTAMP,claim_token=$3,updated_at=CURRENT_TIMESTAMP FROM candidates c WHERE j.export_job_id=c.export_job_id RETURNING j.*`,[limit,leaseSeconds,claimToken]);return r.rows;}
 async complete(client:Pick<PoolClient,"query">,id:string,claimToken:string,attachmentId:string):Promise<void>{const r=await client.query(`UPDATE export_jobs j SET status='succeeded',claimed_at=NULL,claim_token=NULL,result_attachment_id=$3,completed_at=CURRENT_TIMESTAMP,last_error=NULL,updated_at=CURRENT_TIMESTAMP WHERE j.export_job_id=$1 AND j.status='running' AND j.claim_token=$2 AND EXISTS (SELECT 1 FROM attachments a WHERE a.attachment_id=$3 AND a.status='ready' AND (a.uploaded_by=j.requested_by OR (a.entity_type='export_job' AND a.entity_id=j.export_job_id::text)))`,[id,claimToken,attachmentId]);if(r.rowCount!==1)throw new ApplicationError("INVALID_STATE_TRANSITION","Export claim is stale or result attachment is not ready and authorized",409);}
 async fail(client:Pick<PoolClient,"query">,id:string,claimToken:string,error:unknown):Promise<void>{const r=await client.query(`UPDATE export_jobs SET status='failed',claimed_at=NULL,claim_token=NULL,completed_at=CURRENT_TIMESTAMP,last_error=$3,updated_at=CURRENT_TIMESTAMP WHERE export_job_id=$1 AND status='running' AND claim_token=$2`,[id,claimToken,sanitizeOperationalError(error)]);if(r.rowCount!==1)throw new ApplicationError("INVALID_STATE_TRANSITION","Export claim is stale or job is not running",409);}
 private dto(r:Row):ExportJobResponse{return{exportJobId:r.export_job_id,exportType:r.export_type,filters:r.filters,status:r.status,resultAttachmentId:r.result_attachment_id,createdAt:r.created_at.toISOString()};}
}
