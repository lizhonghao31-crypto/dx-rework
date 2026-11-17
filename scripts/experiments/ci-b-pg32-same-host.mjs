import {readFileSync,writeFileSync,mkdirSync,existsSync,rmSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {cpus,totalmem,release,platform} from 'node:os';
const parent=join(process.env.RUNNER_TEMP??'/tmp','ci-b-pg32-evidence');
const files=['tests/helpers/bulk-preparation-fixture.ts','tests/integration/sourcing-pr03-postgres.test.ts'];
const hash=value=>createHash('sha256').update(value).digest('hex');
if(process.argv[2]==='variant'){
 const variant=process.argv[3],source=process.argv[4];
 if(!['original','b'].includes(variant))throw Error('Unexpected experiment variant');
 const condition=JSON.parse(readFileSync('scripts/experiments/ci-b-pg32-same-host-conditions.json','utf8'));
 if(source!==(variant==='b'?condition.B:condition.original))throw Error('Variant source drift');
 const directory=join(parent,variant);mkdirSync(directory,{recursive:true});
 const inputs=files.map(path=>{const bytes=readFileSync(path),expected=execFileSync('git',['show',`${source}:${path}`]);if(!bytes.equals(expected))throw Error('Wrong exact preparation source');return {path,sha256:hash(bytes),bytes:bytes.length};});
 const cache='node_modules/.vite/vitest',before=existsSync(cache);
 if(before&&variant==='original')throw Error('Original expected clean initial results cache');
 if(before)rmSync(cache,{recursive:true});
 const pressure=Object.fromEntries(['cpu','io','memory'].map(name=>{const path='/proc/pressure/'+name;return [name,existsSync(path)?readFileSync(path,'utf8'):'unavailable'];}));
 const metadata={variant,source,experimentHead:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),inputs,at:new Date().toISOString(),cpuModels:[...new Set(cpus().map(c=>c.model))],logicalCpus:cpus().length,totalMemoryBytes:totalmem(),platform:platform(),kernel:release(),imageOS:process.env.ImageOS,imageVersion:process.env.ImageVersion,runnerEnvironment:process.env.RUNNER_ENVIRONMENT,pressure,priorVariantResultCacheRemoved:before,initialResultCacheEmpty:!existsSync(cache),limits:condition.limits};
 writeFileSync(join(directory,'exact-variant-and-machine.json'),JSON.stringify(metadata,null,2)+'\n');console.log(JSON.stringify({variant,source,initialResultCacheEmpty:metadata.initialResultCacheEmpty,inputs}));
}else if(process.argv[2]==='compare'){
 const values=['original','b'].map(variant=>({variant,result:JSON.parse(readFileSync(join(parent,variant,'result.json'),'utf8')),timing:JSON.parse(readFileSync(join(parent,variant,'canonical-timing.json'),'utf8'))}));
 for(const v of values)if(v.result.passed!==573||v.result.failed||v.result.skipped||v.result.cleanup!=='passed')throw Error('Incomplete or failed same-run comparison');
 if(values[0].result.caseIdentityMultisetSha256!==values[1].result.caseIdentityMultisetSha256)throw Error('Case identity multiset drift');
 const report={kind:'same-host sequential original then B experiment; not merge approval',run:process.env.GITHUB_RUN_ID,attempt:process.env.GITHUB_RUN_ATTEMPT,values,differenceSeconds:values[0].timing.wallSeconds-values[1].timing.wallSeconds,limits:JSON.parse(readFileSync('scripts/experiments/ci-b-pg32-same-host-conditions.json','utf8')).limits};
 writeFileSync(join(parent,'same-host-comparison.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}else throw Error('Expected variant or compare');
