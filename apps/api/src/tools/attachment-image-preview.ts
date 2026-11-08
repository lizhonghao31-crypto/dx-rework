import {createHash} from 'node:crypto';
import sharp from 'sharp';
import {ObjectStorageObjectNotFoundError,type ObjectStorage,type StoredObjectMetadata} from './storage.js';

export type PreviewSource={attachmentId:string;objectKey:string;mimeType:string;sizeBytes:number;sha256:string};
const SPEC='v1-320-webp',MAX_OUTPUT_BYTES=512*1024;
/** Private derived bytes only. This cache never stores actors or signed URLs. */
export class AttachmentImagePreviews{
 private readonly pending=new Map<string,Promise<string|null>>();
 private readonly failures=new Map<string,number>();
 private tail:Promise<unknown>=Promise.resolve();
 private queued=0;
 constructor(private readonly storage:ObjectStorage,private readonly prefix:string,private readonly maxBytes:number){}
 key(source:Pick<PreviewSource,'attachmentId'|'sha256'>){
  if(!/^[0-9a-f-]{36}$/i.test(source.attachmentId)||! /^[0-9a-f]{64}$/.test(source.sha256))throw Error('Invalid registered preview identity');
  return `${this.prefix}/image-previews/${SPEC}/${source.attachmentId}/${source.sha256}.webp`;
 }
 prepare(source:PreviewSource,current:()=>Promise<boolean>):Promise<string|null>{
  if(!['image/jpeg','image/png','image/webp'].includes(source.mimeType)||source.sizeBytes<1||source.sizeBytes>this.maxBytes)return Promise.resolve(null);
  const key=this.key(source),existing=this.pending.get(key);if(existing)return existing;
  const now=Date.now();for(const [id,until]of this.failures)if(until<=now)this.failures.delete(id);
  if(this.failures.has(key)||this.pending.size>=32)return Promise.resolve(null);
  // Cache hits do not occupy the decoder queue. Bound metadata requests too;
  // the admission deadline covers both the lookup and any queued generation.
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),5000);timer.unref();
  const job=(async()=>{
   try{
    const found=await this.storage.head(key,controller.signal);controller.signal.throwIfAborted();
    if(!this.valid(found))throw Error('Invalid existing preview');return await current()?key:null;
   }catch(error){if(!(error instanceof ObjectStorageObjectNotFoundError))throw error;}
   // Only missing images consume the one decoder plus eight queued slots.
   if(this.queued>=9)return null;this.queued++;
   const work=this.tail.then(()=>{controller.signal.throwIfAborted();return this.generate(source,key,current,controller.signal);});
   this.tail=work.catch(()=>null);
   try{return await work;}finally{this.queued--;}
  })().catch(()=>{
    if(this.failures.size>=128)this.failures.delete(this.failures.keys().next().value!);
    this.failures.set(key,Date.now()+30000);return null;
  }).finally(()=>{clearTimeout(timer);this.pending.delete(key);});
  this.pending.set(key,job);return job;
 }
 private valid(metadata:StoredObjectMetadata){return metadata.mimeType==='image/webp'&&metadata.sizeBytes>0&&metadata.sizeBytes<=MAX_OUTPUT_BYTES&&/^[0-9a-f]{64}$/.test(metadata.sha256??'');}
 private async generate(source:PreviewSource,key:string,current:()=>Promise<boolean>,signal:AbortSignal):Promise<string|null>{
  try{
   const found=await this.storage.head(key,signal);signal.throwIfAborted();
   if(!this.valid(found))throw Error('Invalid existing preview');
   return await current()?key:null;
  }catch(error){if(!(error instanceof ObjectStorageObjectNotFoundError))throw error;}
  const bytes=await this.storage.readBytes(source.objectKey,this.maxBytes,signal);signal.throwIfAborted();
  if(bytes.byteLength!==source.sizeBytes||createHash('sha256').update(bytes).digest('hex')!==source.sha256)throw Error('Preview source changed');
  const output=await sharp(bytes,{limitInputPixels:40000000,animated:false}).rotate()
   .resize({width:320,height:320,fit:'inside',withoutEnlargement:true}).webp({quality:80,effort:4}).timeout({seconds:3}).toBuffer();
  signal.throwIfAborted();if(output.length>MAX_OUTPUT_BYTES||!await current())return null;
  const sha256=createHash('sha256').update(output).digest('hex');
  try{await this.storage.writeImmutable(key,output,{mimeType:'image/webp',sha256,signal});}
  catch(error){
   // The immutable write may have raced or its acknowledgement may be lost.
   // Verify the exact derived object; never overwrite or blindly retry it.
   signal.throwIfAborted();const found=await this.storage.head(key,signal);
   if(!this.valid(found)||found.sha256!==sha256||found.sizeBytes!==output.length)throw error;
  }
  signal.throwIfAborted();
  if(!await current()){await this.storage.deleteObject(key);return null;}
  return key;
 }
}
