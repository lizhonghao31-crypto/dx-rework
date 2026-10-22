#!/usr/bin/env node
// User-invoked only. Neither deploy, service startup nor migrations import this command.
import {readFile,lstat,realpath,writeFile} from "node:fs/promises";
import {createRequire} from "node:module";
import {fileURLToPath,pathToFileURL} from "node:url";
import {resolve,dirname} from "node:path";
import {randomUUID} from "node:crypto";
import {parseEnv} from "node:util";
import {userInfo} from "node:os";

export function validateHistoryIdentity(deploy,identity) {
  if(deploy.DX_REWORK_PROFILE!=="production"||deploy.DX_REWORK_SERVER_NAME!=="dxerp.org.cn"||deploy.DX_REWORK_NGINX_MODE!=="dedicated_vhost") throw new Error("PRODUCTION_PROFILE_REQUIRED");
  if(identity.database!=="dx_rework"||identity.username!=="dx_rework_app"||identity.superuser||identity.bypassrls) throw new Error("APPLICATION_DATABASE_IDENTITY_REQUIRED");
}
export function summarizeHistoryBatch(result,notExecuted=[]) {
  return {reused:result.reused===true,createdThisInvocation:result.reused?0:result.results.reduce((sum,row)=>sum+(row.createdTodoIds?.length??0),0),
    cyclesCreatedThisInvocation:result.reused?0:result.results.filter(row=>row.cycleCreated).length,
    skipped:result.results.filter(row=>row.action.startsWith("skipped")).length,
    failed:result.results.filter(row=>row.action==="failed").length,
    blocked:result.results.filter(row=>row.action==="blocked_precondition").length,results:result.results,notExecuted};
}
async function secureText(path) {
  const stat=await lstat(path);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.uid!==process.getuid()||(stat.mode&0o777)!==0o600) throw new Error("CONFIG_OR_PREFLIGHT_PERMISSIONS_REQUIRED");
  return readFile(path,"utf8");
}
let writeAttempted=false;
async function main() {
  const [mode,confirmation]=process.argv.slice(2);
  if(!["preview","apply"].includes(mode)||process.argv.length!==(mode==="preview"?3:4)||mode==="apply"&&confirmation!=="--execute-confirmed-three-cases") throw new Error("USE_PREVIEW_OR_EXPLICIT_THREE_CASE_APPLY");
  if(userInfo().username!=="dxrework"||process.versions.node.split(".")[0]!=="22")throw new Error("APPLICATION_OS_USER_AND_NODE22_REQUIRED");
  const root=await realpath("/opt/dx-rework/current");
  if(await realpath(resolve(dirname(fileURLToPath(import.meta.url)),"../.."))!==root)throw new Error("ACTIVE_RELEASE_COMMAND_REQUIRED");
  // Read deployment identity first, before loading application connection values.
  const deploy=parseEnv(await secureText("/opt/dx-rework/shared/deploy.env"));
  if(deploy.DX_REWORK_PROFILE!=="production")throw new Error("PRODUCTION_PROFILE_REQUIRED");
  const application=parseEnv(await secureText("/opt/dx-rework/shared/.env"));
  const release=JSON.parse(await readFile(resolve(root,"release-manifest.json"),"utf8"));
  if(release.schemaVersion!=="0229_sourcing_price_reapplications")throw new Error("MAIN_0229_RELEASE_REQUIRED");
  const require=createRequire(resolve(root,"package.json")),{Pool}=require("pg");
  const database=new Pool({connectionString:application.DATABASE_URL,max:2,connectionTimeoutMillis:5000,
    options:`-c statement_timeout=15000 -c lock_timeout=5000${mode==="preview"?" -c default_transaction_read_only=on":""}`});
  try {
    const identity=(await database.query("SELECT current_database() AS database,current_user AS username,rolsuper AS superuser,rolbypassrls AS bypassrls FROM pg_roles WHERE rolname=current_user")).rows[0];
    validateHistoryIdentity(deploy,identity);
    const history=(await database.query("SELECT version,trim(checksum) AS checksum FROM schema_migrations ORDER BY version")).rows;
    const manifest=JSON.parse(await readFile(resolve(root,"apps/api/src/platform/migration-manifest.json"),"utf8")).migrations;
    if(JSON.stringify(history)!==JSON.stringify(manifest))throw new Error("EXACT_MAIN_SCHEMA_HISTORY_REQUIRED");
    const {RootAuthority}=await import(pathToFileURL(resolve(root,"apps/api/dist/access/root-authority.js")).href);
    const authority=new RootAuthority(database,application.DINGTALK_CORP_ID,application.ROOT_DINGTALK_USER_ID??application.OWNER_BOOTSTRAP_DINGTALK_USER_ID);
    await authority.assertConfigurationConsistency();
    const rootUser=(await database.query("SELECT user_id FROM owner_bootstrap_consumptions WHERE singleton=true")).rows[0]?.user_id;
    if(!rootUser||!await authority.isRootUser(rootUser))throw new Error("VERIFIED_ROOT_IDENTITY_REQUIRED");
    const actor={actorId:rootUser,actorRoles:["root_superuser"],authorizationCapability:"todo:routing_exception_manage",requestId:`three-contract-history:${randomUUID()}`};
    const {SourcingTransferContractReconciliation}=await import(pathToFileURL(resolve(root,"apps/api/dist/sourcing/sourcing-transfer-contract-reconciliation.js")).href);
    const service=new SourcingTransferContractReconciliation(database),path="/opt/dx-rework/shared/contract-return-three-case-preflight.json";
    if(mode==="preview") {
      const preview=await service.preview(actor);
      const selected=preview.results.filter(row=>!row.blocked).map(({caseId,documentId,version,evidenceHash})=>({caseId,documentId,version,evidenceHash}));
      const plan={gitSha:release.gitSha,schemaVersion:release.schemaVersion,schemaChecksum:release.schemaChecksum,batchKey:`three-contract-history:${randomUUID()}`,selected,preview};
      // An existing plan may be replaced only when it has the same strict owner/mode.
      try{await secureText(path);}catch(error){if(error.code!=="ENOENT")throw error;}
      await writeFile(path,JSON.stringify(plan,null,2)+"\n",{mode:0o600});
      console.log(JSON.stringify({mode:"read_only_preflight",...plan},null,2));
      return;
    }
    const plan=JSON.parse(await secureText(path));
    if(plan.gitSha!==release.gitSha||plan.schemaVersion!==release.schemaVersion||plan.schemaChecksum!==release.schemaChecksum||await realpath("/opt/dx-rework/current")!==root)throw new Error("PREFLIGHT_RELEASE_CHANGED_RERUN_PREVIEW");
    const notExecuted=plan.preview.results.filter(row=>row.blocked).map(row=>({caseId:row.caseId,reason:row.reason}));
    writeAttempted=plan.selected.length>0;
    const result=plan.selected.length?await service.apply(actor,plan.selected,"业务负责人显式执行已预检的三单合同周期及缺失待办",plan.batchKey):{reused:false,results:[]};
    const summary=summarizeHistoryBatch(result,notExecuted);
    console.log(JSON.stringify({mode:"explicit_three_case_apply",batchKey:plan.batchKey,...summary},null,2));
    if(summary.failed||summary.blocked||notExecuted.length)process.exitCode=2;
  } finally {await database.end();}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  main().catch(error=>{console.error(JSON.stringify({status:"failed",code:/^[A-Z0-9_]+$/.test(error.message)?error.message:error.code??"HISTORY_OPERATION_FAILED",credentialsSuppressed:true,executionOutcome:writeAttempted?"uncertain_retry_same_saved_batch":"not_executed"}));process.exitCode=1;});
}
