import {createHash,randomUUID} from 'node:crypto';
import sharp from 'sharp';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {AttachmentImagePreviews,type PreviewSource} from '../../apps/api/src/tools/attachment-image-preview.js';
import {FakeObjectStorage} from '../../apps/api/src/tools/storage.js';
import {AttachmentService} from '../../apps/api/src/tools/attachments.js';
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
async function fixture(width=1200,height=800){
 const storage=new FakeObjectStorage(),bytes=await sharp({create:{width,height,channels:3,background:'#3284bf'}}).png().toBuffer();
 const source:PreviewSource={attachmentId:randomUUID(),objectKey:'TEST/original-'+randomUUID(),mimeType:'image/png',sizeBytes:bytes.length,sha256:hash(bytes)};
 await storage.writeImmutable(source.objectKey,bytes,{mimeType:source.mimeType,sha256:source.sha256});
 return {storage,bytes,source,previews:new AttachmentImagePreviews(storage,'TEST',20000000)};
}
afterEach(()=>{vi.useRealTimers();});
describe('private independently versioned image derivatives',()=>{
 it('creates real320 WebP bytes with original aspect and no original mutation; a warm read never decodes the original again',async()=>{
  const f=await fixture(),read=vi.spyOn(f.storage,'readBytes'),current=vi.fn(async()=>true);
  const key=await f.previews.prepare(f.source,current);expect(key).toBe(f.previews.key(f.source));
  const bytes=f.storage.objectBytes.get(key!)!,metadata=await sharp(bytes).metadata();
  expect(metadata).toMatchObject({format:'webp',width:320,height:213});expect(bytes.length).toBeLessThan(f.bytes.length);
  expect(Buffer.from(f.storage.objectBytes.get(f.source.objectKey)!)).toEqual(f.bytes);expect(read).toHaveBeenCalledTimes(1);
  expect(await f.previews.prepare(f.source,current)).toBe(key);expect(read).toHaveBeenCalledTimes(1);
 });
 it('does not enlarge a small original, and original content/attachment/spec identity determine separate private keys',async()=>{
  const f=await fixture(12,8),key=await f.previews.prepare(f.source,async()=>true);
  expect(await sharp(f.storage.objectBytes.get(key!)!).metadata()).toMatchObject({width:12,height:8});
  expect(f.previews.key({...f.source,sha256:'b'.repeat(64)})).not.toBe(key);
  expect(f.previews.key({...f.source,attachmentId:randomUUID()})).not.toBe(key);
  expect(key).toContain('/v1-320-webp/');
 });
 it('deduplicates concurrent generation without sharing authorization results or signed grants',async()=>{
  const f=await fixture(),read=vi.spyOn(f.storage,'readBytes');
  const a=f.previews.prepare(f.source,async()=>true),b=f.previews.prepare(f.source,async()=>true);
  expect(a).toBe(b);expect(await a).toBeTruthy();expect(read).toHaveBeenCalledTimes(1);expect(f.storage.signed).toEqual([]);
 });
 it('serves a whole warm page concurrently without sending cached images back through the bounded decoder queue',async()=>{
  const f=await fixture(),sources=Array.from({length:20},()=>({...f.source,attachmentId:randomUUID()}));
  const expected=[];for(const source of sources)expected.push(await f.previews.prepare(source,async()=>true));
  const read=vi.spyOn(f.storage,'readBytes');expect(await Promise.all(sources.map(source=>f.previews.prepare(source,async()=>true)))).toEqual(expected);
  expect(expected.every(Boolean)).toBe(true);expect(read).not.toHaveBeenCalled();
 });
 it('bounds queued work and aborts a slow provider, then lets the next independent object proceed',async()=>{
  const f=await fixture();vi.useFakeTimers();const original=f.storage.readBytes.bind(f.storage);let first=true;
  vi.spyOn(f.storage,'readBytes').mockImplementation(async(key,max,signal?:AbortSignal)=>{
   if(first){first=false;return new Promise((_resolve,reject)=>signal!.addEventListener('abort',()=>reject(Error('TEST provider aborted')),{once:true}));}
   return original(key,max);
  });
  const jobs=Array.from({length:9},(_,i)=>f.previews.prepare({...f.source,attachmentId:randomUUID(),objectKey:i===0?f.source.objectKey:'TEST/queued-'+i},async()=>true));
  expect(await f.previews.prepare({...f.source,attachmentId:randomUUID()},async()=>true)).toBeNull();
  await vi.advanceTimersByTimeAsync(5001);expect(await Promise.all(jobs)).toEqual(Array(9).fill(null));vi.useRealTimers();
  expect(await f.previews.prepare({...f.source,attachmentId:randomUUID()},async()=>true)).toBeTruthy();
 });
 it('refuses corrupt source bytes, coalesces failures for30s and never rejects or deletes the registered original',async()=>{
  const f=await fixture(),read=vi.spyOn(f.storage,'readBytes'),changed={...f.source,sha256:'a'.repeat(64)};
  expect(await f.previews.prepare(changed,async()=>true)).toBeNull();expect(await f.previews.prepare(changed,async()=>true)).toBeNull();
  expect(read).toHaveBeenCalledTimes(1);expect(f.storage.deleted).toEqual([]);expect(Buffer.from(f.storage.objectBytes.get(f.source.objectKey)!)).toEqual(f.bytes);
 });
 it('keeps a lost immutable-write acknowledgement idempotent by verifying the exact stored derivative',async()=>{
  const f=await fixture(),write=f.storage.writeImmutable.bind(f.storage);
  vi.spyOn(f.storage,'writeImmutable').mockImplementation(async(...args)=>{await write(...args);throw Error('TEST acknowledgement lost');});
  expect(await f.previews.prepare(f.source,async()=>true)).toBe(f.previews.key(f.source));expect(f.storage.objects.size).toBe(2);
 });
 it('does not publish a derivative after the registered original is removed during generation',async()=>{
  const f=await fixture(),write=f.storage.writeImmutable.bind(f.storage);let current=true;
  vi.spyOn(f.storage,'writeImmutable').mockImplementation(async(...args)=>{await write(...args);current=false;});
  expect(await f.previews.prepare(f.source,async()=>current)).toBeNull();
  expect(f.storage.objects.has(f.previews.key(f.source))).toBe(false);expect(f.storage.objects.has(f.source.objectKey)).toBe(true);
 });
 it('rejects non-images and configured oversized originals before reading private bytes',async()=>{
  const f=await fixture(),read=vi.spyOn(f.storage,'readBytes');
  expect(await f.previews.prepare({...f.source,mimeType:'application/pdf'},async()=>true)).toBeNull();
  expect(await f.previews.prepare({...f.source,sizeBytes:20000001},async()=>true)).toBeNull();expect(read).not.toHaveBeenCalled();
 });
});

describe('original attachment authorization before every derivative grant',()=>{
 async function serviceFixture(){
  const f=await fixture(),actor={actorId:randomUUID(),actorRoles:['sample_designer'],authorizationCapability:'digital_production:view',requestId:'TEST preview'};
  const row={attachment_id:f.source.attachmentId,object_key:f.source.objectKey,original_filename:'TEST.png',mime_type:f.source.mimeType,size_bytes:String(f.source.sizeBytes),sha256:f.source.sha256,uploaded_by:actor.actorId,entity_type:'digital_development',entity_id:randomUUID(),status:'ready',created_at:new Date()};
  const query=vi.fn(async()=>({rows:[row],rowCount:1})),client={query:vi.fn(async()=>({rows:[],rowCount:1})),release:vi.fn()};
  const events={append:vi.fn(async()=>undefined)},service=new AttachmentService({query,connect:async()=>client} as never,f.storage,{prefix:'TEST',ttlSeconds:60,maxUploadBytes:20000000},events as never);
  return {...f,actor,row,query,events,service};
 }
 it('checks the bound original before cache access and issues a new original-TTL grant after session/scope recheck',async()=>{
  const f=await serviceFixture(),actor=vi.fn(async()=>f.actor),allowed=vi.fn(async()=>true);
  await f.service.createImagePreviewDownloadIntent(actor,f.source.attachmentId,allowed);
  expect(actor).toHaveBeenCalledTimes(2);expect(allowed).toHaveBeenCalledTimes(2);
  expect(f.storage.signed).toEqual([{method:'GET',objectKey:f.previews.key(f.source),ttlSeconds:60}]);
  allowed.mockResolvedValue(false);await expect(f.service.createImagePreviewDownloadIntent(actor,f.source.attachmentId,allowed)).rejects.toMatchObject({statusCode:403});expect(f.storage.signed).toHaveLength(1);
 });
 it('refuses a revoked scope or expired session after generation instead of issuing a cached grant',async()=>{
  const f=await serviceFixture(),allowed=vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  await expect(f.service.createImagePreviewDownloadIntent(async()=>f.actor,f.source.attachmentId,allowed)).rejects.toMatchObject({statusCode:403});expect(f.storage.signed).toEqual([]);
  const actor=vi.fn().mockResolvedValueOnce(f.actor).mockRejectedValueOnce(Error('TEST expired original session'));
  await expect(f.service.createImagePreviewDownloadIntent(actor,f.source.attachmentId,async()=>true)).rejects.toThrow('expired original session');expect(f.storage.signed).toEqual([]);
 });
 it('falls back to a freshly authorized original when generation fails, with the original unmodified and audited',async()=>{
  const f=await serviceFixture();vi.spyOn(f.storage,'readBytes').mockRejectedValueOnce(Error('TEST decoder input unavailable'));
  await f.service.createImagePreviewDownloadIntent(async()=>f.actor,f.source.attachmentId,async()=>true);
  expect(f.storage.signed).toEqual([{method:'GET',objectKey:f.source.objectKey,ttlSeconds:60}]);expect(f.events.append).toHaveBeenCalledOnce();expect(f.storage.deleted).toEqual([]);
 });
});
