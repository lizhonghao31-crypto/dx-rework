import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {inventorySampleSource,sampleSourceHash} from '../apps/api/src/samples/sample-migration.js';
const [input,output,...extra]=process.argv.slice(2);if(!input||!output||extra.length)throw new Error('Usage: sample-plan-template SOURCE.json NEW_OUTPUT_DIRECTORY');
const {source,report}=inventorySampleSource(JSON.parse(await readFile(resolve(input),'utf8')));
const statusMap:Record<string,string>={BORROWED:'borrowed',IN_STOCK:'in_stock',PENDING_BORROW:'borrow_pending',PENDING_RETURN:'return_pending',PENDING_DISPOSAL:'disposal_pending',SOLD:'sold',GIFTED:'gifted',SCRAPPED:'scrapped',LOST:'lost',ARCHIVED:'archived',LOSS_PAYMENT_PENDING:'loss_payment_pending'};
const decisions=report.issues.map(i=>({...i,conclusion:''}));
const items=source.samples.map(s=>{
 const history=Array.isArray(s.borrowHistory)?s.borrowHistory as Record<string,unknown>[]:[];
 const custody=history.map((h,n)=>{decisions.push({entityType:'sample',legacyId:s.id,code:'HISTORICAL_ACTOR_UNVERIFIABLE',field:`borrowHistory[${n}].requestedBy`,conclusion:''});return {legacyId:String(h.id??`history-${n}`),sourceHash:sampleSourceHash(h),holderUserId:null,holderName:h.borrower,department:h.department??s.department,purpose:h.purpose??'',borrowedAt:h.borrowedAt??h.confirmedAt??h.requestedAt??null,returnedAt:h.returnedAt||null,disposedAt:null,initialCustody:n===0&&String(h.type).toUpperCase()==='PURCHASE',requestedBy:null,confirmedBy:null};});
 const open=custody.filter(h=>!h.returnedAt&&!h.disposedAt).at(-1);
 // Null IDs are deliberate unresolved evidence, never a same-name auto-match or fabricated Root actor.
 return {legacyId:s.id,sourceHash:sampleSourceHash(s),status:statusMap[String(s.status)]??null,purchaserUserId:null,holderUserId:null,holderName:s.currentHolder||null,borrowedAt:s.currentHolder?open?.borrowedAt??null:null,purpose:s.currentHolder?open?.purpose??null:null,storageLocation:s.storageLocation||null,archivedFromStatus:null,archiveReason:null,normalizationReason:'',custody,requests:[]};
});
const directory=resolve(output);await mkdir(directory,{mode:0o700,recursive:false});
await writeFile(join(directory,'plan.template.json'),JSON.stringify({sourceHash:report.sourceHash,reason:'',items,objects:report.attachments.map(o=>({objectKey:o.objectKey,attachmentId:null,sha256:null,sizeBytes:null})),decisions},null,2),{mode:0o600,flag:'wx'});
await writeFile(join(directory,'unresolved.json'),JSON.stringify({sourceHash:report.sourceHash,identities:source.samples.map(s=>({legacyId:s.id,purchaser:s.purchaser,holder:s.currentHolder,department:s.department})),inFlight:source.samples.filter(s=>s.pendingTask||s.disposalRequest||Array.isArray(s.disposalHistory)&&s.disposalHistory.length).map(s=>({legacyId:s.id,pendingTask:s.pendingTask,disposalRequest:s.disposalRequest,disposalHistory:s.disposalHistory})),borrowRequests:source.borrowRequests,issues:report.issues},null,2),{mode:0o600,flag:'wx'});
process.stdout.write(JSON.stringify({sourceHash:report.sourceHash,items:items.length,unresolved:true,readyForImport:false})+'\n');
