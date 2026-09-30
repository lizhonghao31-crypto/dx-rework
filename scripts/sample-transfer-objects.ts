import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve,dirname,join,basename} from 'node:path';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {UploadIntentResponseSchema,AttachmentResponseSchema} from '@dx-rework/contracts';
const [manifestPath,output,...extra]=process.argv.slice(2);if(!manifestPath||!output||extra.length)throw new Error('Usage: sample-transfer-objects OBJECTS.json NEW_OUTPUT_DIRECTORY');
const manifest=z.object({sourceHash:z.string().regex(/^[a-f0-9]{64}$/),objects:z.array(z.object({objectKey:z.string(),status:z.literal('verified'),localFile:z.string(),sha256:z.string().regex(/^[a-f0-9]{64}$/),sizeBytes:z.number().int().positive(),mimeType:z.string().startsWith('image/')}))}).parse(JSON.parse(await readFile(resolve(manifestPath),'utf8')));
const endpoint=process.env.SAMPLE_PLATFORM_API_URL,session=process.env.SAMPLE_PLATFORM_SESSION;if(!endpoint||!session)throw new Error('Authenticated platform API URL and Root session are required');const base=new URL(endpoint.endsWith('/')?endpoint:`${endpoint}/`);if(base.protocol!=='https:'||base.username||base.password||base.search||base.hash)throw new Error('A clean HTTPS platform API URL is required');
const identityResponse=await fetch(new URL('auth/me',base),{redirect:'error',signal:AbortSignal.timeout(30000),headers:{cookie:`dx_rework_session=${session}`}});
if(!identityResponse.ok||!z.object({user:z.object({isRoot:z.literal(true)})}).safeParse(await identityResponse.json()).success)throw new Error('Object transfer requires a verified platform Root session');
const directory=resolve(output);await mkdir(directory,{mode:0o700,recursive:true});
async function request(path:string,body?:unknown){const response=await fetch(new URL(path,base),{method:'POST',redirect:'error',signal:AbortSignal.timeout(60000),headers:{cookie:`dx_rework_session=${session}`,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});if(!response.ok)throw new Error(`Platform attachment request HTTP ${response.status}`);return response.json();}
const savedSchema=z.object({sourceHash:z.string(),objects:z.array(z.object({objectKey:z.string(),attachmentId:z.string().uuid(),sha256:z.string(),sizeBytes:z.number()}))});
let objects:z.infer<typeof savedSchema>['objects']=[];
try{const saved=savedSchema.parse(JSON.parse(await readFile(join(directory,'transferred.json'),'utf8')));if(saved.sourceHash!==manifest.sourceHash)throw new Error('Resume manifest belongs to another source snapshot');objects=saved.objects;}catch(error){if((error as {code?:string}).code!=='ENOENT')throw error;}
for(const object of manifest.objects){
 if(basename(object.localFile)!==object.localFile)throw new Error('Invalid local object path');const bytes=await readFile(join(dirname(resolve(manifestPath)),object.localFile));if(bytes.length!==object.sizeBytes||createHash('sha256').update(bytes).digest('hex')!==object.sha256)throw new Error('Local object changed after verification');
 const previous=objects.find(o=>o.objectKey===object.objectKey);if(previous){if(previous.sha256!==object.sha256||previous.sizeBytes!==object.sizeBytes)throw new Error('Resume object does not match verified source');continue;}
 const filename=`sample-${object.sha256}.${object.mimeType==='image/png'?'png':object.mimeType==='image/webp'?'webp':'jpg'}`;
 const intent=UploadIntentResponseSchema.parse(await request('tools/attachments/upload-intents',{filename,mimeType:object.mimeType,sizeBytes:object.sizeBytes,sha256:object.sha256}));const upload=new URL(intent.uploadUrl);if(upload.protocol!=='https:'||upload.username||upload.password)throw new Error('Invalid platform upload URL');
 // Only the platform-issued OSS form is sent to OSS; the platform session remains on its own API.
 const form=new FormData();for(const [key,value]of Object.entries(intent.uploadFields))form.append(key,value);form.append('file',new Blob([new Uint8Array(bytes)],{type:object.mimeType}),filename);
 const response=await fetch(upload,{method:'POST',redirect:'error',body:form,signal:AbortSignal.timeout(120000)});if(!response.ok)throw new Error(`Object transfer HTTP ${response.status}`);
 AttachmentResponseSchema.parse(await request(`tools/attachments/${intent.attachmentId}/finalize`));objects.push({objectKey:object.objectKey,attachmentId:intent.attachmentId,sha256:object.sha256,sizeBytes:object.sizeBytes});
 await writeFile(join(directory,'transferred.json'),JSON.stringify({sourceHash:manifest.sourceHash,objects},null,2),{mode:0o600});
}
process.stdout.write(JSON.stringify({sourceHash:manifest.sourceHash,transferred:objects.length})+'\n');
