import {runOwnedCommand,ownedInterruptionGuard} from './owned-command.mjs';
import {assertFixturePrerequisites} from './test-fixture-prerequisites.mjs';
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {rm,readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {STATIC_CHAIN_TESTS,postgresPlan,fullGatePostgresPlan,assertSuiteResults,executionFingerprint,assertExecutionReceipt} from './test-suite-plan.mjs';
import {resourceContext,resourceEnvironment,cleanupResources,resourceSmoke} from './test-resource-lifecycle.mjs';

const DEFAULT_ECS_ENV_FILE='/opt/dx-rework/shared/.env';
const runtimeEnvFile=process.env.DX_REWORK_ENV_FILE||DEFAULT_ECS_ENV_FILE;
const hasSharedRuntimeEnv=existsSync(runtimeEnvFile);
const RUNTIME_ENV_KEYS=new Set(['OSS_REGION','OSS_ENDPOINT','OSS_BUCKET','OSS_ACCESS_KEY_ID','OSS_ACCESS_KEY_SECRET','OSS_PRIVATE_PREFIX','DINGTALK_QR_REDIRECT_URI']);
if(hasSharedRuntimeEnv)for(const line of (await readFile(runtimeEnvFile,'utf8')).split(/\r?\n/)){
 const match=line.trim().match(/^(?:export\s+)?([A-Z0-9_]+)=(.*)$/);if(!match||!RUNTIME_ENV_KEYS.has(match[1])||process.env[match[1]])continue;
 process.env[match[1]]=match[2].trim().replace(/^["']|["']$/g,'');
}
const databaseUrl=process.env.TEST_DATABASE_URL?.trim(),hasDatabase=Boolean(databaseUrl),hasOss=Boolean(process.env.OSS_BUCKET);
const full=process.argv.includes('--full-gate'),verify=process.argv.includes('--verify-receipt');
const receiptPath=process.env.DX_REWORK_POSTGRES_RECEIPT;
const declared=full?fullGatePostgresPlan(process.env):null;
if(declared?.status==='not-applicable'){
 if(receiptPath)writeFileSync(receiptPath,JSON.stringify({status:'not-applicable',reason:'no database-sensitive scope'}));
 console.log('POSTGRES_NOT_APPLICABLE: no PostgreSQL pass signed');process.exit(0);
}
const chain=declared?.chain??true,mapped=declared?.mapped??[];
if(full&&!process.env.GITHUB_RUN_ID&&!process.env.DX_REWORK_TEST_EXECUTION_ID)throw Error('POSTGRES_LOCAL_EXECUTION_ID_REQUIRED');
if((full||process.env.DX_REWORK_REQUIRE_TEST_DATABASE==='true')&&!hasDatabase)throw Error('BUSINESS_CHAIN_TEST_DATABASE_REQUIRED: explicit TEST_DATABASE_URL is required');
function ossBrowserBaseUrl(endpointValue, bucket) {
  const endpoint = new URL(endpointValue);
  if (endpoint.protocol !== "https:") {
    throw new Error("OSS runtime preflight requires an HTTPS endpoint");
  }
  if (endpoint.hostname.includes("-internal.")) {
    throw new Error("OSS runtime preflight requires a public browser-reachable endpoint");
  }
  if (endpoint.pathname !== "/" || endpoint.search || endpoint.hash) {
    throw new Error("OSS runtime preflight endpoint must not contain path/query/fragment");
  }
  if (!endpoint.hostname.startsWith(`${bucket}.`)) {
    endpoint.hostname = `${bucket}.${endpoint.hostname}`;
  }
  return endpoint;
}

async function verifyOssRuntime() {
  if (!hasOss) {
    if (hasSharedRuntimeEnv) {
      throw new Error(
        "OSS_RUNTIME_PREFLIGHT_FAILED: business acceptance runtime must configure OSS",
      );
    }
    process.stdout.write("OSS_RUNTIME_PREFLIGHT_SKIPPED: OSS is not configured in this local environment\n");
    return;
  }

  const required = [
    "OSS_REGION",
    "OSS_ENDPOINT",
    "OSS_BUCKET",
    "OSS_ACCESS_KEY_ID",
    "OSS_ACCESS_KEY_SECRET",
    "DINGTALK_QR_REDIRECT_URI",
  ];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length) {
    throw new Error(`OSS_RUNTIME_PREFLIGHT_FAILED: missing ${missing.join(",")}`);
  }

  const bucket = process.env.OSS_BUCKET;
  const endpoint = process.env.OSS_ENDPOINT;
  const origin = new URL(process.env.DINGTALK_QR_REDIRECT_URI).origin;
  const baseUrl = ossBrowserBaseUrl(endpoint, bucket);
  const privatePrefix = (process.env.OSS_PRIVATE_PREFIX || "dx-rework/private").replace(/\/$/, "");
  const { AliyunOssV4RestClient } = await import(
    new URL("../apps/api/dist/tools/aliyun-oss-v4-client.js", import.meta.url)
  );
  const client = new AliyunOssV4RestClient({
    region: process.env.OSS_REGION,
    endpoint,
    bucket,
    accessKeyId: process.env.OSS_ACCESS_KEY_ID,
    accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET,
  });

  const missingObjectKey = `${privatePrefix}/__runtime-preflight__/${randomUUID()}.txt`;
  let signedHeadReturnedNotFound = false;
  try {
    await client.head(missingObjectKey);
  } catch (error) {
    if (error && typeof error === "object" && error.statusCode === 404) {
      signedHeadReturnedNotFound = true;
    } else {
      throw new Error(
        `OSS_RUNTIME_PREFLIGHT_FAILED: signed HEAD did not authenticate (${error instanceof Error ? error.message : "unknown error"})`,
      );
    }
  }
  if (!signedHeadReturnedNotFound) {
    throw new Error("OSS_RUNTIME_PREFLIGHT_FAILED: random missing object unexpectedly exists");
  }

  const corsProbeUrl = new URL(
    `/dx-rework-cors-preflight/${randomUUID()}.txt`,
    baseUrl,
  );
  const cors = await fetch(corsProbeUrl, {
    method: "OPTIONS",
    headers: {
      Origin: origin,
      "Access-Control-Request-Method": "POST",
    },
  });
  const allowedOrigin = cors.headers.get("access-control-allow-origin");
  if (!cors.ok || (allowedOrigin !== origin && allowedOrigin !== "*")) {
    throw new Error(
      `OSS_RUNTIME_PREFLIGHT_FAILED: bucket CORS does not allow POST from ${origin}`,
    );
  }

  process.stdout.write("OSS_RUNTIME_PREFLIGHT_PASSED: signed HEAD + browser POST CORS\n");
}


async function runVitest(files,config,environment,output){
 if(!files.length)return;
 interruption.assertActive();
 const metadata=await runOwnedCommand(process.execPath,['scripts/ci/test-runtime-metadata.mjs','--config',config],{stateFile:environment.DX_REWORK_TEST_EXECUTION_STATE,env:{...process.env,...environment,NODE_ENV:'test',DATABASE_URL:'',DX_REWORK_TEST_SUITE_KIND:'postgres'}});
 interruption.assertActive();if(metadata.code!==0)throw Error('TEST_RUNTIME_CONTEXT_REJECTED');
 const {code}=await runOwnedCommand(process.execPath,['node_modules/vitest/vitest.mjs','run','--config',config,'--reporter=default','--reporter=json','--outputFile='+output,...files],{stateFile:environment.DX_REWORK_TEST_EXECUTION_STATE,env:{...process.env,...environment,NODE_ENV:'test',DATABASE_URL:'',DX_REWORK_TEST_SUITE_KIND:'postgres'}});
 interruption.assertActive();
 if(code!==0)throw Error('BUSINESS_CHAIN_GATE_FAILED: vitest exited '+code);
 const report=JSON.parse(readFileSync(output,'utf8'));assertSuiteResults(report,files);return report;
}
const interruption=ownedInterruptionGuard();
if(!hasDatabase&&process.argv.includes('--static-already-validated')){
 console.log('BUSINESS_CHAIN_DATABASE_NOT_VERIFIED: no explicit TEST_DATABASE_URL; static tests already ran in the canonical non-DB suite');
}else if(!hasDatabase){
 await runVitest(STATIC_CHAIN_TESTS,'vitest.config.ts',{TEST_DATABASE_URL:'',ACCEPTANCE_CLOCK_TEST_DATABASE_URL:''},'/tmp/dx-static-chain-'+randomUUID()+'.json');
 await verifyOssRuntime();console.log('BUSINESS_CHAIN_STATIC_GATES_PASSED');
}else{
 const plan=declared?.plan??postgresPlan({mapped,chain});
 await assertFixturePrerequisites(databaseUrl,plan);
 const resources=await resourceContext({default:databaseUrl,...(process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL?{'acceptance-clock':process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL}:{})});
 let cleanupPassed=false;
 const context={head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),base:process.env.BASE_SHA??null,runId:process.env.GITHUB_RUN_ID??null,attempt:process.env.GITHUB_RUN_ATTEMPT??null,identities:resources.identities,executionId:process.env.DX_REWORK_TEST_EXECUTION_ID??`${process.env.GITHUB_RUN_ID}/${process.env.GITHUB_RUN_ATTEMPT}`,node:process.versions.node,nodeEnv:'test',databaseUrlCleared:true};
 try{
  if(verify){if(!receiptPath)throw Error('POSTGRES_RECEIPT_REQUIRED');assertExecutionReceipt(JSON.parse(readFileSync(receiptPath,'utf8')),context,plan);console.log('BUSINESS_CHAIN_COVERAGE_VERIFIED: same execution covers mapped and chain');}
  else{
   if(full&&!receiptPath)throw Error('POSTGRES_RECEIPT_REQUIRED');
   if(receiptPath)writeFileSync(receiptPath,JSON.stringify({status:'running'}));
   await resourceSmoke(databaseUrl);
   const env={...resourceEnvironment(resources),TEST_DATABASE_URL:databaseUrl};
   console.log('OWNED_TEST_EXECUTION_STATE='+env.DX_REWORK_TEST_EXECUTION_STATE);
   const reports=[];let safeToClean=true;
   try{
    // Directly affected ordinary PG suites run before long current-schema correctness chains.
    for(const config of ['vitest.config.ts','vitest.business-chain.config.ts']){
     const files=plan.filter(s=>s.config===config).map(s=>s.path);if(files.length)reports.push(await runVitest(files,config,env,resources.dir+'-'+config+'.json'));
    }
   }catch(error){if(error.unsafeToCleanup)safeToClean=false;throw error;}
   finally{if(safeToClean){await cleanupResources(resources);cleanupPassed=true;}else console.error('TEST_RESOURCE_WORKERS_NOT_STOPPED: retaining '+resources.dir);}
   const results={success:true,numFailedTests:0,numFailedTestSuites:0,testResults:reports.flatMap(r=>r.testResults)};
   assertSuiteResults(results,plan.map(s=>s.path));
   if(chain)await verifyOssRuntime();
   interruption.assertActive();
   if(receiptPath)writeFileSync(receiptPath,JSON.stringify({version:1,status:'passed',cleanup:'passed',context,plan,results,fingerprint:executionFingerprint(context,plan)}));
   console.log('BUSINESS_CHAIN_GATE_PASSED: '+plan.length+' unique PostgreSQL suites');
  }
 }finally{if(verify||cleanupPassed)await rm(resources.dir,{recursive:true,force:true});else console.error('TEST_RESOURCE_CLEANUP_EVIDENCE_RETAINED: '+resources.dir);}
}
interruption.close();
