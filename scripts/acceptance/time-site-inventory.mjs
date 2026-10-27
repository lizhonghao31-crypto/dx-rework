import {readdir,readFile,writeFile} from 'node:fs/promises';
import {relative,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

const inventoryPath='docs/engineering/acceptance-time-sites-20261027.json';
const roots=['apps/api/src','apps/web/src','packages/domain/src','packages/contracts/src','apps/api/migrations','scripts'];
const patterns={wall:/\b(?:CURRENT_TIMESTAMP|CURRENT_DATE|LOCALTIMESTAMP|clock_timestamp\s*\(|statement_timestamp\s*\(|transaction_timestamp\s*\(|Date\.now\s*\(|new Date\s*\(\s*\))/g,
 business:/\b(?:businessNow|observedBusinessTime|ContextBusinessClock|SystemBusinessClock|BusinessClock|businessToday|beijingCalendarDate)\b/g,
 dateControl:/type=["']date["']|type:\s*["']date["']|\b(?:maxDate|minDate|date_target)\b/g,
 anchor:/\b(?:max|min)\s*\([^;\n]*(?:_at|occurred|completed|generated)|Math\.(?:max|min)\([^;\n]*(?:[Aa]t|[Tt]ime|[Dd]ate)/gi};
function ownership(path){
 if(path.startsWith('scripts/'))return 'PR6';
 if(/production[-_]reporting|production[-_]execution|factory[-_]remainder[-_]executions|factory-transfer-service/.test(path))return 'PR2';
 if(/contract-return|contract_return|return-cycle/.test(path))return 'PR3';
 if(path.startsWith('apps/web/'))return 'PR5';
 if(/factory-flow-service|factory-batch-timing|contract-business-ready|budget-sourcing-adapter|work-reporting-service|\/task-service|0263_contract_business_ready/.test(path))return 'PR1';
 return 'PR4';
}
/** Candidate index, not a semantic approval. In particular SQL audit defaults
 * may feed business MAX/history consumers, and are never auto-exempted. */
export async function timeSiteInventory(){
 const files=[];
 const walk=async directory=>{for(const entry of await readdir(directory,{withFileTypes:true})){const path=`${directory}/${entry.name}`;if(entry.isDirectory())await walk(path);else if(/\.(?:ts|tsx|mjs|sql)$/.test(path)&&path!=='scripts/acceptance/time-site-inventory.mjs')files.push(path);}};
 for(const root of roots)await walk(root);
 const entries=[];
 for(const path of files.sort()){
  const text=await readFile(path,'utf8'),sites=[];
  for(const [kind,pattern] of Object.entries(patterns))for(const match of text.matchAll(pattern)){
   const start=text.lastIndexOf('\n',match.index)+1,end=text.indexOf('\n',match.index),line=text.slice(start,end<0?text.length:end).trim();
   // Record exact source text, not a broad file suppression. Line numbers are
   // informational; this identity remains stable when an import is inserted.
   sites.push({kind,line:text.slice(0,start).split('\n').length,sourceSha256:createHash('sha256').update(line).digest('hex')});
  }
  if(/(?:routes|app|server)\.ts$/.test(path)&&path.startsWith('apps/api/')){
   for(const match of text.matchAll(/\.(?:get|post|put|patch|delete|route)\s*\(/g)){
    const start=text.lastIndexOf('\n',match.index)+1,end=text.indexOf('\n',match.index),line=text.slice(start,end<0?text.length:end).trim();
    sites.push({kind:'route',line:text.slice(0,start).split('\n').length,sourceSha256:createHash('sha256').update(line).digest('hex')});
   }
  }
  if(sites.length)entries.push({path,owner:ownership(path),semanticStatus:'pending-per-entry-review',sites:sites.sort((a,b)=>a.line-b.line||a.kind.localeCompare(b.kind))});
 }
 return entries;
}
export async function checkTimeSiteInventory(){
 const actual=await timeSiteInventory(),frozen=JSON.parse(await readFile(inventoryPath,'utf8')).entries.map(entry=>({...entry,sites:entry.sites.map(([line,kind,sourceSha256])=>({line,kind,sourceSha256}))}));
 const identities=entries=>entries.flatMap(file=>file.sites.map(site=>`${file.path}:${site.kind}:${site.sourceSha256}`)).sort();
 const before=identities(frozen),after=identities(actual);
 return JSON.stringify(before)===JSON.stringify(after)?[]:['Time source candidates changed: review the occurrence/consumer chain and refresh the explicit inventory.'];
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 if(process.argv[2]==='--write'){
  const entries=await timeSiteInventory(),header={sourceBase:'21aa4de4f4c33c645d42aa60dcdc24cab0823480',purpose:'Candidate index; pending means NOT verified or approved. See semantic chains and per-PR evidence.',siteColumns:['line','kind','sourceSha256']};
  const rows=entries.map(entry=>JSON.stringify({...entry,sites:entry.sites.map(site=>[site.line,site.kind,site.sourceSha256])}));
  await writeFile(inventoryPath,JSON.stringify(header).slice(0,-1)+',"entries":[\n'+rows.join(',\n')+'\n]}\n');
  process.stdout.write(JSON.stringify({files:entries.length,sites:entries.reduce((n,e)=>n+e.sites.length,0),path:relative(process.cwd(),resolve(inventoryPath))})+'\n');
 }else{const errors=await checkTimeSiteInventory();if(errors.length){process.stderr.write(errors.join('\n')+'\n');process.exitCode=1;}else process.stdout.write('Time source candidate inventory matches; semantic verification remains separate.\n');}
}
