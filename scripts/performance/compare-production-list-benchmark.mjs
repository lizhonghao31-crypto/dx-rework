import {readFile,writeFile} from 'node:fs/promises';
import {isDeepStrictEqual} from 'node:util';
const [baselinePath,candidatePath,outputPath]=process.argv.slice(2);
if(!baselinePath||!candidatePath||!outputPath)throw Error('Usage: node compare-production-list-benchmark.mjs baseline.json candidate.json report.json');
const baseline=JSON.parse(await readFile(baselinePath,'utf8')),candidate=JSON.parse(await readFile(candidatePath,'utf8'));
if(!isDeepStrictEqual(baseline.seed,candidate.seed))throw Error('Before/after require the identical owned TEST seed');
// These additive, source-authorized display fields replace the old designer row requests.
const normalize=value=>JSON.parse(JSON.stringify(value,(key,item)=>['developmentType','requiredCompletionDate'].includes(key)?undefined:item));
const parity=candidate.oracle.map(row=>{const prior=baseline.oracle.find(item=>item.role===row.role&&item.path===row.path);return {role:row.role,path:row.path,sameStatus:prior?.status===row.status,equal:prior&&isDeepStrictEqual(normalize(prior.body),normalize(row.body))};});
const metrics=Object.fromEntries(Object.entries(candidate.summary).map(([key,value])=>[key,{before:baseline.summary[key]??null,after:value}]));
const report={localOnly:true,acceptanceOrEcsSla:false,baselineSource:baseline.sourceSha,candidateSource:candidate.sourceSha,conditions:candidate.conditions,sourceFileSha256:{before:baseline.sourceFileSha256,after:candidate.sourceFileSha256},data:{sources:candidate.seed.sourceIds.length,tasks:candidate.seed.taskIds.length},parity,metrics,topBefore:baseline.sqlGroups.slice(0,4),topAfter:candidate.sqlGroups.slice(0,4)};
await writeFile(outputPath,JSON.stringify(report,null,2)+'\n');
if(parity.some(row=>!row.equal||!row.sameStatus))throw Error('Result/permission regression: see report parity');
console.log(JSON.stringify({scenarios:Object.keys(metrics).length,parity:parity.length,allEqual:true}));
