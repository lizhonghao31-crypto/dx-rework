import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {inventorySampleSource,parseSampleSource,sampleSourceHash} from '../apps/api/src/samples/sample-migration.js';
import {validateSampleImport} from '../apps/api/src/samples/sample-import-service.js';
import {SampleCutoverSchema} from '@dx-rework/contracts';
const [command,sourceFile,planFile,output,...extra]=process.argv.slice(2);
if(!command||!sourceFile||!planFile||!output||extra.length||!['validate','import','cutover'].includes(command))throw new Error('Usage: sample-migration-execute validate|import|cutover SOURCE.json PLAN_OR_CUTOVER.json NEW_OUTPUT_DIRECTORY');
const source=parseSampleSource(JSON.parse(await readFile(resolve(sourceFile),'utf8'))),plan=JSON.parse(await readFile(resolve(planFile),'utf8'));
let result:unknown;
if(command==='validate'){const {report}=validateSampleImport(source,plan);result={sourceHash:report.sourceHash,samples:report.sampleCount,objects:report.attachments.length,readyForImport:true};}
else{
 const endpoint=process.env.SAMPLE_PLATFORM_API_URL,session=process.env.SAMPLE_PLATFORM_SESSION;if(!endpoint||!session)throw new Error('Set SAMPLE_PLATFORM_API_URL and an authenticated Root SAMPLE_PLATFORM_SESSION in the process environment');
 const base=new URL(endpoint.endsWith('/')?endpoint:`${endpoint}/`);if(base.protocol!=='https:'||base.username||base.password||base.search||base.hash)throw new Error('A clean HTTPS platform API base URL is required');
 let body:unknown;if(command==='import'){validateSampleImport(source,plan);body={source,plan};}
 else{const cutover=SampleCutoverSchema.parse(plan);if(cutover.action==='enable'){
   const response=await fetch('https://staging-api.dxerp.org.cn/sample/api/cloud-db',{redirect:'error',signal:AbortSignal.timeout(30000)});if(!response.ok)throw new Error(`Final source read HTTP ${response.status}`);
   const fresh=inventorySampleSource(await response.json());if(fresh.report.sourceHash!==cutover.sourceHash||sampleSourceHash(source)!==cutover.sourceHash)throw new Error('Frozen source changed: final delta and reconciliation must run again');
  }body=cutover;}
 const response=await fetch(new URL(`samples/migration/${command}`,base),{method:'POST',redirect:'error',signal:AbortSignal.timeout(600000),headers:{'content-type':'application/json',cookie:`dx_rework_session=${session}`,'idempotency-key':randomUUID()},body:JSON.stringify(body)});
 const payload=await response.json();if(!response.ok)throw new Error(`Migration HTTP ${response.status}: ${payload?.error?.message??'rejected'}`);result=payload;
}
await mkdir(resolve(output),{mode:0o700,recursive:false});await writeFile(join(resolve(output),'result.json'),JSON.stringify(result,null,2),{mode:0o600,flag:'wx'});
process.stdout.write(JSON.stringify({command,sourceHash:sampleSourceHash(source),resultSaved:true})+'\n');
