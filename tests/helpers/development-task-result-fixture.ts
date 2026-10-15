import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import type {TrustedActorContext} from '../../apps/api/src/tools/repositories.js';
import type {DevelopmentExecutionService} from '../../apps/api/src/production-platform/development-execution-service.js';
/** Isolated synthetic ready upload through the real purpose/permission guard. */
export async function taskResult(db:Pool,service:DevelopmentExecutionService,actor:TrustedActorContext,sourceId:string,taskId:string,purpose:'纸样成果'|'车板成果'){
 const id=randomUUID();
 await db.query("INSERT INTO attachments(attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,uploaded_by,status,ready_at) VALUES($1,$2,'TEST-result.png','image/png',100,$3,$4,'ready',CURRENT_TIMESTAMP)",[id,`test-r2-result/${id}`,'e'.repeat(64),actor.actorId]);
 await service.recordUploadPurpose(actor,sourceId,id,purpose,taskId);return id;
}
