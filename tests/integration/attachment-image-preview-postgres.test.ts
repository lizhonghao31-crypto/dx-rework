import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import Fastify from 'fastify';
import sharp from 'sharp';
import {afterAll,afterEach,beforeAll,describe,expect,it,vi} from 'vitest';
import {testExecutionConfig} from '../../scripts/test-execution-config.mjs';
import {businessAnchorFixture} from '../helpers/business-anchor-fixture.js';
import {AuthService,AuthDeniedError} from '../../apps/api/src/auth/service.js';
import {AcceptanceDingTalkProvider,mintAcceptanceLoginCode} from '../../apps/api/src/auth/acceptance-provider.js';
import {PostgresAuthStore} from '../../apps/api/src/auth/postgres-store.js';
import {registerAuthRoutes} from '../../apps/api/src/auth/routes.js';
import {RootAuthority} from '../../apps/api/src/access/root-authority.js';
import {AttachmentService} from '../../apps/api/src/tools/attachments.js';
import {AttachmentImagePreviews} from '../../apps/api/src/tools/attachment-image-preview.js';
import {AcceptanceObjectStorage,registerAcceptanceStorageRoutes} from '../../apps/api/src/tools/acceptance-storage.js';
import {DigitalDevelopmentService} from '../../apps/api/src/production-platform/development-service.js';
import {DigitalProductionIdentityService} from '../../apps/api/src/production-platform/identity-service.js';
import {registerDevelopmentRoutes} from '../../apps/api/src/production-platform/development-routes.js';
import {registerInstructionRoutes} from '../../apps/api/src/production-platform/production-instruction-routes.js';
import {ProductionInstructionService} from '../../apps/api/src/production-platform/production-instruction-service.js';
import {DevelopmentRoundService} from '../../apps/api/src/production-platform/development-round-service.js';
import {DevelopmentDocumentSchema} from '@dx-rework/contracts/digital-development';
import type {ApplicationError} from '../../apps/api/src/platform/errors.js';
vi.setConfig({testTimeout:testExecutionConfig.correctnessTimeoutMs,hookTimeout:testExecutionConfig.correctnessTimeoutMs});
const url=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL,hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
(url?describe.sequential:describe.skip)('PERF05 native private image bytes and original signed sessions',()=>{
 let f:Awaited<ReturnType<typeof businessAnchorFixture>>,directory:string,storage:AcceptanceObjectStorage,attachments:AttachmentService,forms:DigitalDevelopmentService,identity:DigitalProductionIdentityService;
 let app:ReturnType<typeof Fastify>,designerCookie:string,rootCookie:string,sourceId:string,version=0;
 const secret='TEST isolated preview native authentication '.repeat(3),admin=()=>({...f.root,authorizationCapability:'access:admin',authorizationCapabilities:['access:admin']});
 const login=async(userId:string)=>{
  const mapping=(await f.db.query('SELECT provider_user_id FROM identity_mappings WHERE user_id=$1 AND active AND employed',[userId])).rows[0];
  const response=await app.inject({method:'POST',url:'/auth/mobile',remoteAddress:'127.0.0.'+(++logins),payload:{code:mintAcceptanceLoginCode(mapping.provider_user_id.slice(4),secret)}});
  expect(response.statusCode).toBe(200);return response.cookies.find(cookie=>cookie.name==='dx_rework_session')!.value;
 };let logins=0;
 const request=(path:string,cookie=designerCookie)=>app.inject({method:'GET',url:path,...(cookie?{headers:{cookie:'dx_rework_session='+cookie}}:{})});
 const path=(attachmentId:string)=>`/digital-production/sources/${sourceId}/development/attachments/${attachmentId}`;
 const download=async(response:Awaited<ReturnType<typeof app.inject>>)=>{expect(response.statusCode).toBe(302);const target=new URL(response.headers.location!);return app.inject({method:'GET',url:target.pathname+target.search});};
 const image=async(old=false)=>{
  const bytes=await sharp({create:{width:1200,height:800,channels:3,background:'#3482be'}}).png().toBuffer(),sha256=hash(bytes);
  let attachmentId:string,objectKey:string;
  if(old){attachmentId=randomUUID();objectKey='TEST/historical/'+attachmentId;await storage.writeImmutable(objectKey,bytes,{mimeType:'image/png',sha256});
   await f.db.query(`INSERT INTO attachments(attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,uploaded_by,status,ready_at)VALUES($1,$2,'TEST-old.png','image/png',$3,$4,$5,'ready',CURRENT_TIMESTAMP)`,[attachmentId,objectKey,bytes.length,sha256,f.people['sample-designer']!.actorId]);
  }else{
   const intent=await attachments.createUploadIntent(f.people['sample-designer']!,{filename:'TEST-new.png',mimeType:'image/png',sizeBytes:bytes.length,sha256});attachmentId=intent.attachmentId;objectKey=intent.objectKey;
   await storage.writeImmutable(objectKey,bytes,{mimeType:'image/png',sha256});await attachments.finalize(f.people['sample-designer']!,attachmentId);
  }
  const document=DevelopmentDocumentSchema.parse({documentFormatVersion:2,sizeQuantities:[],template:'上衣',quantity:null,sampleSize:'',orderDate:null,returnDate:null,unit:'cm',sizes:[],measurements:[],interlining:'',placketInterlining:'',sewingThread:'',buttonholeThread:'',stitchDensity:'',washingIroning:'',packaging:'',formalSizes:'',casualSizes:'',mainLabel:false,mainLabelMethod:'',sizeLabel:false,careLabel:false,instructions:'TEST preview fixture',craft:'无',washing:'免洗',materials:[],files:[{attachmentId,kind:'款图'}]});
  const saved=await forms.save(f.people['sample-designer']!,sourceId,{expectedVersion:version,document},randomUUID());version=saved.version;
  return {attachmentId,objectKey,bytes,sha256};
 };
 beforeAll(async()=>{
  f=await businessAnchorFixture(url!);directory=await mkdtemp(join(tmpdir(),'dx-perf05-private-'));storage=new AcceptanceObjectStorage(directory,'http://test','TEST local preview grants only');
  attachments=new AttachmentService(f.db,storage,{prefix:'TEST',ttlSeconds:60,maxUploadBytes:1000000});identity=new DigitalProductionIdentityService(f.db,true);forms=new DigitalDevelopmentService(f.db,true);
  sourceId=(await identity.createSource(f.people['sample-designer']!,{developmentType:'头版',designStyleNo:'TEST-PREVIEW-'+randomUUID(),temporaryStyleNo:null,customerCode:'PD'},randomUUID())).sourceId;
  const root=new RootAuthority(f.db,'anchor-test','uat-root'),auth=new AuthService(new AcceptanceDingTalkProvider(f.db,'anchor-test',secret),new PostgresAuthStore(f.db,'anchor-test','uat-root'),'anchor-test',3600000,secret);
  app=Fastify();registerAuthRoutes(app,auth,{secureCookie:false,ttlSeconds:3600,appBasePath:'/',corpId:'anchor-test',mobileClientId:'TEST',webClientId:'TEST',qrRedirectUri:'https://acceptance.invalid/auth/qr/callback',isRootUser:id=>root.isRootUser(id)});
  app.setErrorHandler((error,_request,reply)=>{const value=error as ApplicationError;void reply.code(error instanceof AuthDeniedError?401:value.statusCode??500).send({error:{code:value.code,message:value.message}});});
  const deps={service:identity,creationEnabled:true,root,authenticate:(token:string|undefined)=>auth.authenticate(token)};
  registerDevelopmentRoutes(app,deps,forms,attachments);registerInstructionRoutes(app,deps,new ProductionInstructionService(f.db,true),attachments);registerAcceptanceStorageRoutes(app,storage);await app.ready();
  designerCookie=await login(f.people['sample-designer']!.actorId);rootCookie=await login(f.root.actorId);
 });
 afterEach(()=>vi.restoreAllMocks());
 afterAll(async()=>{try{await app?.close();await f?.dispose();}finally{if(directory)await rm(directory,{recursive:true,force:true});}});
 it('generates new uploads after ready commit, serves actual smaller WebP, and leaves the full original byte-for-byte intact',async()=>{
  const value=await image(),previewKey=new AttachmentImagePreviews(storage,'TEST',1000000).key(value);
  expect((await storage.head(previewKey)).mimeType).toBe('image/webp');
  const preview=await download(await request(path(value.attachmentId)+'/preview'));expect(preview.statusCode).toBe(200);expect(preview.headers['content-type']).toContain('image/webp');expect(preview.headers['cache-control']).toContain('no-store');
  expect(await sharp(preview.rawPayload).metadata()).toMatchObject({width:320,height:213});expect(preview.rawPayload.length).toBeLessThan(value.bytes.length);
  const original=await download(await request(path(value.attachmentId)));expect(hash(original.rawPayload)).toBe(value.sha256);expect(original.rawPayload).toEqual(value.bytes);
 });
 it('builds a historical image only on demand, reuses its bytes without reading the original again, and skips the full development form',async()=>{
  const value=await image(true),key=new AttachmentImagePreviews(storage,'TEST',1000000).key(value);await expect(storage.head(key)).rejects.toThrow();
  const read=vi.spyOn(storage,'readBytes'),formRead=vi.spyOn(forms,'read').mockRejectedValue(Error('TEST full form forbidden in image read'));
  const first=await request(path(value.attachmentId)+'/preview');expect(first.statusCode).toBe(302);expect(read.mock.calls.filter(([key])=>key===value.objectKey)).toHaveLength(1);
  const second=await request(path(value.attachmentId)+'/preview');expect(second.statusCode).toBe(302);expect(read.mock.calls.filter(([key])=>key===value.objectKey)).toHaveLength(1);
  const metadata=await request(path(value.attachmentId)+'/metadata');expect(metadata.statusCode).toBe(200);expect(metadata.json().attachmentId).toBe(value.attachmentId);expect(formRead).not.toHaveBeenCalled();
  expect(hash((await download(first)).rawPayload)).toBe(hash((await download(second)).rawPayload));
 });
 it('does not share a cached grant with an anonymous request or an unrelated source, while Root still uses its original native access',async()=>{
  const value=await image();expect((await request(path(value.attachmentId)+'/preview')).statusCode).toBe(302);
  expect((await request(path(value.attachmentId)+'/preview','')).statusCode).toBe(401);
  const other=(await identity.createSource(f.root,{developmentType:'头版',designStyleNo:'TEST-OTHER-PREVIEW-'+randomUUID(),temporaryStyleNo:null,customerCode:'PD'},randomUUID())).sourceId;
  expect((await request(path(value.attachmentId).replace(sourceId,other)+'/preview')).statusCode).toBe(404);
  expect((await request(path(value.attachmentId)+'/preview',rootCookie)).statusCode).toBe(302);
 });
 it('returns the authorized original on derivative failure and keeps later independent objects usable',async()=>{
  const value=await image(true),read=storage.readBytes.bind(storage);vi.spyOn(storage,'readBytes').mockImplementation(async(key,max)=>{if(key===value.objectKey)throw Error('TEST preview provider unavailable');return read(key,max);});
  const grant=await request(path(value.attachmentId)+'/preview');expect(grant.statusCode).toBe(302);vi.restoreAllMocks();expect(hash((await download(grant)).rawPayload)).toBe(value.sha256);
  const next=await image();expect((await download(await request(path(next.attachmentId)+'/preview'))).headers['content-type']).toContain('image/webp');
 });
 it('keeps actual inherited source images and published instruction versions behind their original binding policies',async()=>{
  const ready=await f.bulkReady('无'),sheet=await forms.read(f.root,ready.sourceId),photo=sheet.document!.files.find(file=>file.kind==='款图')!.attachmentId;
  const row=(await f.db.query('SELECT object_key,mime_type,sha256 FROM attachments WHERE attachment_id=$1',[photo])).rows[0];
  await storage.writeImmutable(row.object_key,f.storage.objectBytes.get(row.object_key)!,{mimeType:row.mime_type,sha256:row.sha256});
  const rounds=new DevelopmentRoundService(f.db,true),saved=await rounds.save(f.root,ready.sourceId,{expectedDraftVersion:0,revision:{basedOnRound:1,document:sheet.document!,origin:'客户新增要求',customerComment:'TEST客户增加版型要求',internalProblem:'',explanation:'TEST original attachment inheritance',categories:['版型'],affectedNodes:['纸样','车板'],outputKind:'整件样板'}},randomUUID());
  const child=await rounds.publish(f.root,ready.sourceId,{expectedDraftVersion:saved.draftVersion,basedOnRound:1},randomUUID());expect(child.sourceId).toBeTruthy();expect(child.sourceId).not.toBe(ready.sourceId);
  const childPath=`/digital-production/sources/${child.sourceId}/development/attachments/${photo}`;
  const inherited=await download(await request(childPath+'/preview'));expect(inherited.headers['content-type']).toContain('image/webp');
  expect(hash((await download(await request(childPath))).rawPayload)).toBe(row.sha256);
  const foreign=await image();expect([403,404]).toContain((await request(childPath.replace(photo,foreign.attachmentId)+'/preview')).statusCode);
  const instructionPath=`/digital-production/orders/${ready.id}/instruction/attachments/${photo}`;
  expect((await download(await request(instructionPath+'/preview',rootCookie))).headers['content-type']).toContain('image/webp');
  expect(hash((await download(await request(instructionPath,rootCookie))).rawPayload)).toBe(row.sha256);
 });
 it('rechecks the same real valid signed session if native scope is revoked during generation and does not issue a private grant',async()=>{
  const value=await image(true),who=f.people['sample-designer']!.actorId;await f.access.assignRole(admin(),{userId:who,roleCode:'finance_read',reason:'TEST keep original signed session valid after native role revocation'});
  const assignment=(await f.db.query("SELECT assignment_id FROM user_role_assignments WHERE user_id=$1 AND role_code='sample_designer' AND revoked_at IS NULL",[who])).rows[0].assignment_id,write=storage.writeImmutable.bind(storage);
  vi.spyOn(storage,'writeImmutable').mockImplementation(async(...args)=>{await write(...args);if(args[0].includes('/image-previews/'))await f.access.revokeRole(admin(),assignment,'TEST native permission revoked during bounded image generation');});
  const response=await request(path(value.attachmentId)+'/preview');expect([403,404]).toContain(response.statusCode);expect(response.headers.location).toBeUndefined();
  expect((await request('/auth/me')).statusCode).toBe(200);expect((await request(path(value.attachmentId)+'/preview',rootCookie)).statusCode).toBe(302);
 });
});
