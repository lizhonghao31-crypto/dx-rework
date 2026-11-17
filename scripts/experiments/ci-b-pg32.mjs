import {readFileSync,writeFileSync,appendFileSync,existsSync,mkdirSync,readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {cpus,totalmem} from 'node:os';
import {classifyFullGatePaths} from '../ci/full-gate-risk-map.mjs';
import {postgresPlan,fullGatePostgresPlan,assertSuiteResults} from '../test-suite-plan.mjs';
import {runOwnedCommand} from '../owned-command.mjs';
const mode=process.argv[2];
const manifest=JSON.parse(readFileSync('scripts/experiments/ci-b-pg32-workload.json','utf8'));
const root=process.env.EXPERIMENT_EVIDENCE_DIR??'/tmp/ci-b-pg32-evidence';mkdirSync(root,{recursive:true});
const sha=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
const digest=value=>createHash('sha256').update(value).digest('hex');
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const risk=classifyFullGatePaths(manifest.historicalChangedPaths);
const plan=postgresPlan({mapped:risk.mappedPostgresTests,chain:risk.businessChainSensitive,rootAudit:risk.migrationSensitive});
if(!equal(plan,manifest.canonical.plan)||plan.length!==32||manifest.expectedTests!==573)throw Error('FROZEN_WORKLOAD_CHANGED');
const changedBusiness=execFileSync('git',['diff','--name-only',manifest.executionBase,'--','apps','packages','package.json','package-lock.json'],{encoding:'utf8'}).trim();
if(changedBusiness)throw Error('BENCHMARK_BUSINESS_OR_DEPENDENCY_CHANGED: '+changedBusiness);
if(process.env.GITHUB_SHA&&sha!==process.env.GITHUB_SHA)throw Error('BENCHMARK_HEAD_MISMATCH');
const environment={...manifest.environment,MAPPED_POSTGRES_TESTS:manifest.canonical.mapped.join(','),BASE_SHA:manifest.workloadOrigin.base};
if(!equal(fullGatePostgresPlan(environment).plan,plan))throw Error('CANONICAL_RUNNER_PLAN_CHANGED');
if(mode==='prepare'){
 if(!process.env.GITHUB_ENV)throw Error('GITHUB_ENV_REQUIRED');
 for(const[key,value]of Object.entries(environment)){if(!/^[A-Z][A-Z0-9_]*$/.test(key)||/[\r\n]/.test(value))throw Error('BAD_FROZEN_ENVIRONMENT');appendFileSync(process.env.GITHUB_ENV,key+'='+value+'\n');}
 const metadata={kind:'experiment-only-not-final-gate',head:sha,executionBase:manifest.executionBase,workloadOrigin:manifest.workloadOrigin,workloadSha256:digest(readFileSync('scripts/experiments/ci-b-pg32-workload.json')),node:process.version,nodeEnv:process.env.NODE_ENV,npm:execFileSync('npm',['--version'],{encoding:'utf8'}).trim(),runner:{os:process.env.RUNNER_OS,imageOS:process.env.ImageOS,imageVersion:process.env.ImageVersion,cpuCount:cpus().length,memoryBytes:totalmem()},plan,risk,runId:process.env.GITHUB_RUN_ID,attempt:process.env.GITHUB_RUN_ATTEMPT,limitations:manifest.limitations};
 writeFileSync(join(root,'environment-and-plan.json'),JSON.stringify(metadata,null,2)+'\n');console.log(JSON.stringify({head:sha,suites:32,expectedTests:573,kind:metadata.kind}));
}else if(mode==='run'){
 const cacheRoot='node_modules/.vite/vitest',cache=[];
 if(existsSync(cacheRoot))for(const dir of readdirSync(cacheRoot)){const path=join(cacheRoot,dir,'results.json');if(existsSync(path))cache.push({path,sha256:digest(readFileSync(path)),bytes:readFileSync(path).length});}
 writeFileSync(join(root,'vitest-results-cache-before.json'),JSON.stringify(cache,null,2)+'\n');
 if(cache.length)throw Error('BENCHMARK_EXPECTED_FRESH_VITEST_RESULT_CACHE');
 const startedAt=new Date().toISOString(),start=performance.now();let code=1,error=null;
 try{const result=await runOwnedCommand(process.execPath,['scripts/run-business-chain-gate.mjs','--full-gate'],{stateFile:join(root,'owned-controller.json'),env:{...process.env,...environment,DX_REWORK_POSTGRES_RECEIPT:join(root,'postgres-execution.json'),DX_REWORK_TEST_EXECUTION_ID:'github-ci-b-'+process.env.GITHUB_RUN_ID+'/'+process.env.GITHUB_RUN_ATTEMPT}});code=result.code;}catch(e){error=String(e);throw e;}finally{writeFileSync(join(root,'canonical-timing.json'),JSON.stringify({kind:'fixed-workload-pg-experiment-only',head:sha,runId:process.env.GITHUB_RUN_ID,attempt:process.env.GITHUB_RUN_ATTEMPT,startedAt,endedAt:new Date().toISOString(),wallSeconds:(performance.now()-start)/1000,exitCode:code,error},null,2)+'\n');}
 if(code!==0)throw Error('BENCHMARK_CANONICAL_EXECUTION_FAILED: '+code);
 const receipt=JSON.parse(readFileSync(join(root,'postgres-execution.json'),'utf8'));
 if(receipt.status!=='passed'||receipt.cleanup!=='passed'||!equal(receipt.plan,plan)||receipt.context.head!==sha||String(receipt.context.runId)!==process.env.GITHUB_RUN_ID||String(receipt.context.attempt)!==process.env.GITHUB_RUN_ATTEMPT)throw Error('BENCHMARK_RECEIPT_REJECTED');
 assertSuiteResults(receipt.results,plan.map(s=>s.path));
 const actual={};let passed=0;
 for(const suite of receipt.results.testResults){const item=plan.find(p=>suite.name.endsWith('/'+p.path));if(!item)throw Error('UNPLANNED_SUITE');for(const c of suite.assertionResults){if(c.status!=='passed')throw Error('BENCHMARK_FAILED_OR_SKIPPED_CASE');const key=JSON.stringify([item.config,item.path,c.ancestorTitles,c.title,c.fullName]);actual[key]=(actual[key]??0)+1;passed++;}}
 const sorted=Object.fromEntries(Object.entries(actual).sort(([a],[b])=>a.localeCompare(b)));
 const expected=Object.fromEntries(Object.entries(manifest.expectedCases).map(([key,count])=>[JSON.stringify(JSON.parse(key)),count]).sort(([a],[b])=>a.localeCompare(b)));
 if(passed!==573||!equal(sorted,expected))throw Error('CASE_IDENTITY_OR_MULTIPLICITY_CHANGED');
 const result={kind:'benchmark-not-final-gate',head:sha,suites:32,passed,failed:0,skipped:0,cleanup:'passed',caseIdentityMultisetSha256:digest(JSON.stringify(sorted)),receiptSha256:digest(readFileSync(join(root,'postgres-execution.json')))};writeFileSync(join(root,'result.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
}else if(mode==='validate-only'){console.log(JSON.stringify({status:'manifest-valid',suites:32,expectedTests:573,kind:'static-validation-only'}));}
else throw Error('Expected prepare, run or validate-only');
