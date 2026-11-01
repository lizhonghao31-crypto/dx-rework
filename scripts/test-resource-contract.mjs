import {randomUUID} from 'node:crypto';
import {mkdirSync,writeFileSync,readFileSync,readdirSync,lstatSync} from 'node:fs';
import {join} from 'node:path';

// Creation and cleanup consume this one registry. Unknown prefixes fail before CREATE.
export const SCHEMA_PREFIXES = Object.freeze(["acceptance_clock", "acceptance_cutting", "acceptance_owner", "acceptance_people", "acceptance_roles", "access", "admin_audit", "analysis_v2", "auth_revoke", "auxiliary_catalog", "business_anchors", "craft_catalog", "customer_quote", "development_amendment", "development_execution", "development_sla", "digital_delivery", "digital_development", "digital_identity", "digital_journey", "digital_notifications", "digital_own_todo", "digital_tasks", "employee_access", "erp_todo_transfer", "exception_captions", "external_responsibility", "external_workflow", "finance_access", "full_chain", "global_todo", "historical_source", "management_reporting", "migration_compat", "misc_association", "optional_tail", "own_tail", "pattern_backfill", "po_foundation", "po_main_switch", "process", "qc_other_craft", "quality_basic", "receiving", "resource_smoke", "responsibility", "responsibility_repair", "responsibility_review", "responsibility_s2", "rework", "rework_source", "rework_source_legacy", "rework_v2", "root_http_1", "root_http_2", "root_self_admin", "sample", "shared_budget", "sla_config", "sla_plan", "sourcing", "supplier", "temporary_proxy", "todo_backfill", "todo_foundation", "tools", "wage_backfill", "wage_marker", "wage_workflow", "whole", "work"]);
const suffix=/^[0-9a-f]{32}$/;
const generated=new Map();
export function assertRegisteredSchema(schema) {
 const prefix=schema.slice(0,-33),token=schema.slice(-32);
 if(!SCHEMA_PREFIXES.includes(prefix)||schema[prefix.length]!=='_'||!suffix.test(token))throw Error('TEST_RESOURCE_UNREGISTERED: '+schema);
 return prefix;
}
export function ownedPostgresSchema(prefix,databaseTarget='default',environment=process.env) {
 if(!SCHEMA_PREFIXES.includes(prefix))throw Error('TEST_RESOURCE_UNREGISTERED: '+prefix);
 if(!['default','acceptance-clock'].includes(databaseTarget)||databaseTarget==='acceptance-clock'&&prefix!=='business_anchors')throw Error('TEST_RESOURCE_TARGET_REJECTED');
 const runId=environment.DX_REWORK_TEST_RUN_ID,dir=environment.DX_REWORK_TEST_RESOURCE_MANIFEST_DIR;
 if(Boolean(runId)!==Boolean(dir)||runId&&!/^[0-9a-f]{8}$/.test(runId))throw Error('TEST_RESOURCE_RUN_REJECTED');
 const schema=prefix+'_'+(runId?runId+randomUUID().replaceAll('-','').slice(8):randomUUID().replaceAll('-',''));
 if(runId){
  const identity=JSON.parse(environment.DX_REWORK_TEST_RESOURCE_IDENTITIES??'{}')[databaseTarget];
  if(!identity?.databaseOid||!identity?.database||!identity?.username||identity.marker!=='dx-rework-isolated-test-v1')throw Error('TEST_RESOURCE_IDENTITY_REQUIRED');
  mkdirSync(dir,{recursive:true});
  writeFileSync(join(dir,schema+'.json'),JSON.stringify({version:1,kind:'postgres-schema',runId,schema,databaseTarget,identity})+'\n',{flag:'wx',mode:0o600});
 }
 generated.set(schema,{databaseTarget,url:databaseTarget==='acceptance-clock'?environment.ACCEPTANCE_CLOCK_TEST_DATABASE_URL:environment.TEST_DATABASE_URL,identity:runId?JSON.parse(environment.DX_REWORK_TEST_RESOURCE_IDENTITIES)[databaseTarget]:null});return schema;
}
export function readOwnedResources(dir,runId,identities) {
 if(!/^[0-9a-f]{8}$/.test(runId))throw Error('TEST_RESOURCE_RUN_REJECTED');
 return readdirSync(dir).map(name=>{
  const path=join(dir,name);
  if(!name.endsWith('.json')||!lstatSync(path).isFile()||lstatSync(path).isSymbolicLink())throw Error('TEST_RESOURCE_MANIFEST_REJECTED');
  const r=JSON.parse(readFileSync(path,'utf8'));assertRegisteredSchema(r.schema??'');
  if(r.version!==1||r.kind!=='postgres-schema'||r.runId!==runId||!r.schema.slice(-32).startsWith(runId)||name!==r.schema+'.json'||!identities[r.databaseTarget]||JSON.stringify(r.identity)!==JSON.stringify(identities[r.databaseTarget]))throw Error('TEST_RESOURCE_MANIFEST_REJECTED: '+name);
  if(r.databaseTarget==='acceptance-clock'&&!r.schema.startsWith('business_anchors_'))throw Error('TEST_RESOURCE_TARGET_REJECTED');
  return r;
 });
}
export async function dropOwnedPostgresSchema(pool,schema) {
 if(!generated.has(schema))throw Error('TEST_RESOURCE_NOT_CREATED_BY_THIS_PROCESS');
 assertRegisteredSchema(schema);
 const {assertTestDatabaseTarget}=await import('./test-database-safety.mjs');
 const actual=await assertTestDatabaseTarget(generated.get(schema).url,pool);
 const expected=generated.get(schema).identity;
 if(expected&&JSON.stringify(actual)!==JSON.stringify(expected))throw Error('TEST_RESOURCE_LIVE_IDENTITY_CHANGED');
 const acquired=typeof pool.totalCount==='number';
 const client=acquired?await pool.connect():pool;
 try{await client.query('BEGIN');await client.query("SELECT pg_advisory_xact_lock(hashtextextended('test-owned-schema-teardown-v1',0))");await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await client.query('COMMIT');}
 catch(error){await client.query('ROLLBACK');throw error;}finally{if(acquired)client.release();}
}
