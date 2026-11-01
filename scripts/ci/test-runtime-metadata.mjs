import{readFileSync}from'node:fs';import{execFileSync}from'node:child_process';import{availableParallelism}from'node:os';import{pathToFileURL}from'node:url';
import{testExecutionConfig}from'../test-execution-config.mjs';
export function runtimeMetadata(){return{node:process.versions.node,requiredNode:readFileSync('.node-version','utf8').trim(),npm:execFileSync('npm',['--version'],{encoding:'utf8'}).trim(),packageManager:JSON.parse(readFileSync('package.json','utf8')).packageManager,availableCpus:availableParallelism(),workers:testExecutionConfig.workers,correctnessTimeoutMs:testExecutionConfig.correctnessTimeoutMs,boundary:'CPU availability and worker limits are observations, not proof of identical PG/host resources.'};}
if(import.meta.url===pathToFileURL(process.argv[1]??'').href){
 const r=runtimeMetadata();if(process.env.GITHUB_ACTIONS==='true'&&(r.node!==r.requiredNode||'npm@'+r.npm!==r.packageManager))throw Error('CI_TOOLCHAIN_VERSION_CHANGED');
 const at=process.argv.indexOf('--config');if(at>=0){
  const config=process.argv[at+1];if(!['vitest.config.ts','vitest.postgres-immediate.config.ts','vitest.business-chain.config.ts'].includes(config))throw Error('TEST_CONFIG_NOT_CANONICAL');
  const {resolveConfig}=await import('vitest/node');const {vitestConfig}=await resolveConfig({config});
  const expected=config==='vitest.business-chain.config.ts'?r.workers.longCorrectness:config==='vitest.postgres-immediate.config.ts'?r.workers.postgres:process.env.DX_REWORK_TEST_SUITE_KIND==='postgres'?r.workers.postgres:r.workers.nonDatabase;
  r.resolved={config,maxWorkers:vitestConfig.maxWorkers,testTimeout:vitestConfig.testTimeout,pool:vitestConfig.pool};
  if(r.resolved.maxWorkers!==expected)throw Error('TEST_WORKER_CONFIG_DRIFT');
 }
 console.log('TEST_RUNTIME_METADATA='+JSON.stringify(r));
}
