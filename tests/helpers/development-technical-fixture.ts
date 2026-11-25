import {createHash,randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import type {TrustedActorContext} from '../../apps/api/src/tools/repositories.js';
import type {AttachmentService} from '../../apps/api/src/tools/attachments.js';
import type {FakeObjectStorage} from '../../apps/api/src/tools/storage.js';
import {DevelopmentTechnicalService} from '../../apps/api/src/production-platform/development-technical-service.js';
import {DevelopmentExecutionService} from '../../apps/api/src/production-platform/development-execution-service.js';
import {DigitalProductionTaskService} from '../../apps/api/src/production-platform/task-service.js';
import {publishedTechnicalArtifact,technicalEnrollment} from '../../apps/api/src/production-platform/development-technical-repository.js';
import type {DevelopmentDocument} from '@dx-rework/contracts/digital-development';
/** Production-focused prerequisite only. Native publication/review are real; physical sample work is not claimed.
 * If no private storage is supplied, ready file metadata is an explicit fixture like its existing ready image prerequisites.
 * The dedicated development-technical PostgreSQL suite exercises the actual intent/storage/finalize/download pipeline. */
export async function publishedTechnicalFixture(db:Pool,root:TrustedActorContext,sourceId:string,document:DevelopmentDocument,documentVersion:number,workerId:string,attachments?:AttachmentService,storage?:Pick<FakeObjectStorage,'writeImmutable'>,roundNumber=1,consumptionRows?:{materialId:string;unit:string;consumption:string}[]){
 if(!await technicalEnrollment(db,sourceId))return null;
 const prior=await publishedTechnicalArtifact(db,sourceId,roundNumber);if(prior)return {artifactSetId:prior.artifact.artifactSetId,version:prior.artifact.version};
 const tasks=new DigitalProductionTaskService(db),client=await db.connect();let taskId:string;
 try{await client.query('BEGIN');const existing=(await client.query(`SELECT t.task_id FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) WHERE a.source_id=$1 AND t.route_version=$2 AND a.task_kind='development_pattern' AND t.state='ready' ORDER BY t.created_at DESC LIMIT 1`,[sourceId,roundNumber])).rows[0];
  if(existing)taskId=existing.task_id;else{const occurrence=(await client.query("SELECT coalesce(max(t.occurrence),0)+1 AS n FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) WHERE a.source_id=$1 AND a.task_kind='development_pattern'",[sourceId])).rows[0].n;
   const task=await tasks.createWithClient(client,root,{resource:{kind:'source',id:sourceId},kind:'development_pattern',routeId:randomUUID(),routeVersion:roundNumber,occurrence,assigneeId:workerId});taskId=task.taskId;
   await tasks.setConditionWithClient(client,root,taskId,'materials_ready',true,undefined,'TEST production fixture: material prerequisite');
   await tasks.setConditionWithClient(client,root,taskId,'handover_received',true,undefined,'TEST production fixture: actual handover prerequisite');}
  await client.query('COMMIT');
 }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
 const bytes=Buffer.from('IN;SP1;PU0,0;PD10,10;SP0;'),sha256=createHash('sha256').update(bytes).digest('hex'),execution=new DevelopmentExecutionService(db,true),technical=new DevelopmentTechnicalService(db,true);let plt:string;
 if(attachments&&storage){const intent=await attachments.createTechnicalPlotUploadIntent(root,sourceId,taskId,{filename:'TEST-prerequisite.plt',mimeType:'application/octet-stream',sizeBytes:bytes.length,sha256});plt=intent.attachmentId;await execution.recordUploadPurpose(root,sourceId,plt,'纸样成果',taskId);await storage.writeImmutable(intent.objectKey,bytes,{mimeType:'application/octet-stream',sha256});await attachments.finalize(root,plt);}
 else{plt=randomUUID();await db.query("INSERT INTO attachments(attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,uploaded_by,status,ready_at) VALUES($1,$2,'TEST-prerequisite.plt','application/octet-stream',$3,$4,$5,'ready',CURRENT_TIMESTAMP)",[plt,`TEST-ready-plot/${plt}`,bytes.length,sha256,root.actorId]);await execution.recordUploadPurpose(root,sourceId,plt,'纸样成果',taskId);}
 return technical.saveArtifact(root,sourceId,{taskId,expectedDocumentVersion:documentVersion,expectedVersion:0,scopeRef:'整款',action:'publish',body:{pltAttachmentIds:[plt],consumptionRows:consumptionRows??document.materials.filter(m=>m.name.trim()).map(m=>({materialId:m.materialId,unit:'米',consumption:'1'})),baseSizeTable:{unit:document.unit,baseSize:document.sampleSize,sizes:document.sizes,measurements:document.measurements.map(m=>({pointId:randomUUID(),name:m.name,values:m.values,tolerance:'',method:''})),gradingNote:'TEST explicit native production prerequisite',templateRef:null},note:'TEST production fixture prerequisite',basedOnFinalComment:null}},randomUUID());
}
export async function confirmedTechnicalFixture(db:Pool,root:TrustedActorContext,sourceId:string,document:DevelopmentDocument,documentVersion:number,workerId:string,attachments?:AttachmentService,storage?:Pick<FakeObjectStorage,'writeImmutable'>,roundNumber=1){
 if(!await technicalEnrollment(db,sourceId)){await new DevelopmentExecutionService(db,true).customerSample(root,sourceId,{routeVersion:roundNumber,note:'TEST historical customer confirmation'},randomUUID());return;}
 const artifact=(await publishedTechnicalFixture(db,root,sourceId,document,documentVersion,workerId,attachments,storage,roundNumber))!,technical=new DevelopmentTechnicalService(db,true),state=await technical.read(root,sourceId,roundNumber);
 const comment=await technical.recordComment(root,sourceId,{roundNumber,scopeRef:'整款',expectedVersion:state.comments[0]?.version??0,isFinal:true,decision:'approved',text:'TEST approved sample prerequisite',evidenceRefs:[],evidenceNote:'TEST fixture condition for downstream production tests',occurredAt:null},randomUUID());
 await technical.completeReview(root,sourceId,{taskId:comment.reviewTaskId!,expectedReviewVersion:1,finalCommentId:comment.commentId,finalCommentVersion:comment.version,decision:'reuse',artifactSetId:artifact.artifactSetId,artifactVersion:artifact.version,note:'TEST explicit prerequisite review'},randomUUID());
}
