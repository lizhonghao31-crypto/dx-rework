import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {expect,vi} from 'vitest';
import {AttachmentService} from '../../apps/api/src/tools/attachments.js';
import {FakeObjectStorage} from '../../apps/api/src/tools/storage.js';
import type {TrustedActorContext} from '../../apps/api/src/tools/repositories.js';
import {ApplicationError} from '../../apps/api/src/platform/errors.js';
import {uploadAttachmentWithRecovery} from '../../apps/web/src/attachment-upload-recovery.js';
import {RequestFeedbackError} from '../../apps/web/src/request-response-feedback.js';
export async function exerciseAttachmentRecovery(db:Pool,owner:TrustedActorContext,other:TrustedActorContext){
 const storage=new FakeObjectStorage(),service=new AttachmentService(db,storage,{prefix:'TEST-p14',ttlSeconds:60,maxUploadBytes:10000});
 const original=new File(['%PDF-1.4\n%%EOF\n'],'TEST-proof.pdf',{type:'application/pdf'});let intentId='',objectKey='',intentCalls=0,transfers=0,finalizes=0,lose=true;
 const api={createIntent:async(input:Parameters<AttachmentService['createUploadIntent']>[1])=>{intentCalls++;const intent=await service.createUploadIntent(owner,input);intentId=intent.attachmentId;objectKey=intent.objectKey;return intent;},finalize:async(id:string)=>{finalizes++;const ready=await service.finalize(owner,id);if(lose){lose=false;throw new TypeError('TEST response lost after actual ready transaction');}return ready;}};
 vi.stubGlobal('fetch',async(_url:unknown,init:RequestInit)=>{transfers++;const form=init.body as FormData,file=form.get('file') as File;expect(form.get('key')).toBe(objectKey);expect(form.get('x-oss-forbid-overwrite')).toBe('true');await storage.writeImmutable(objectKey,new Uint8Array(await file.arrayBuffer()),{mimeType:file.type,sha256:String(form.get('x-oss-meta-sha256'))});return new Response(null,{status:204});});
 try{
  const scope=`TEST-p14:${randomUUID()}`;
  await expect(uploadAttachmentWithRecovery(original,scope,api)).rejects.toMatchObject({stage:'finalize',attachmentId:expect.any(String)});
  expect((await db.query('SELECT status,entity_type,entity_id FROM attachments WHERE attachment_id=$1',[intentId])).rows[0]).toEqual({status:'ready',entity_type:null,entity_id:null});
  const result=await uploadAttachmentWithRecovery(original,scope,api);expect(result.attachmentId).toBe(intentId);expect([intentCalls,transfers,finalizes]).toEqual([1,1,2]);
  const before=(await db.query('SELECT action FROM operation_events WHERE entity_type=\'attachment\' AND entity_id=$1 ORDER BY created_at,event_id',[intentId])).rows;
  expect(before.map(row=>row.action).sort()).toEqual(['attachment.ready','attachment.upload_requested']);
  await expect(service.finalize(other,intentId)).rejects.toMatchObject({statusCode:403});await expect(service.createDownloadIntent(other,intentId)).rejects.toMatchObject({statusCode:403});
  expect((await db.query('SELECT action FROM operation_events WHERE entity_type=\'attachment\' AND entity_id=$1 ORDER BY created_at,event_id',[intentId])).rows).toEqual(before);
  expect((await service.createDownloadIntent(owner,intentId)).downloadUrl).toContain('private.example.test');expect(storage.deleted).toEqual([]);
  const absent=await service.createUploadIntent(owner,{filename:'TEST-absent.pdf',mimeType:'application/pdf',sizeBytes:original.size,sha256:result.sha256});
  await expect(service.finalize(owner,absent.attachmentId)).rejects.toMatchObject({code:'ATTACHMENT_METADATA_MISMATCH',statusCode:422});
  expect((await db.query('SELECT status,rejection_reason FROM attachments WHERE attachment_id=$1',[absent.attachmentId])).rows[0]).toEqual({status:'rejected',rejection_reason:'object_not_found'});
  // A definite rejected object is distinct from a permission error or missing ID.
  const missing=new File(['%PDF-1.4\n%%EOF\n'],'TEST-expired-grant.pdf',{type:'application/pdf'});let created=0;
  const absentApi={createIntent:async(input:Parameters<AttachmentService['createUploadIntent']>[1])=>{created++;return service.createUploadIntent(owner,input);},finalize:async(id:string)=>{try{return await service.finalize(owner,id);}catch(error){if(error instanceof ApplicationError)throw new RequestFeedbackError(error.message,'rejected',error.statusCode,error.code);throw error;}}};
  vi.stubGlobal('fetch',async()=>new Response(null,{status:403}));const absentScope=randomUUID();
  await expect(uploadAttachmentWithRecovery(missing,absentScope,absentApi)).rejects.toMatchObject({stage:'transfer'});
  await expect(uploadAttachmentWithRecovery(missing,absentScope,absentApi)).rejects.toMatchObject({stage:'finalize'});expect(created).toBe(1);expect(storage.deleted).toEqual([]);
 }finally{vi.unstubAllGlobals();}
}
