import assert from 'node:assert/strict';
import {test} from 'node:test';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,readFileSync,writeFileSync,rmSync,mkdirSync,cpSync,existsSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {postgresPlan,configForSuite,assertSuiteResults,assertExecutionReceipt,executionFingerprint,fullGatePostgresPlan,POSTGRES_CHAIN_TESTS,ROOT_AUDIT_TESTS} from '../test-suite-plan.mjs';
import {ownedPostgresSchema,createOwnedPostgresSchema,readOwnedResource,readOwnedResources,SCHEMA_PREFIXES,assertMainMaintenanceTarget,claimMainMaintenancePublic} from '../test-resource-contract.mjs';
import {testExecutionConfig} from '../test-execution-config.mjs';
import {classifyFullGatePaths,EXISTING_MAPPED_POSTGRES_TESTS} from './full-gate-risk-map.mjs';
import {assertManagedSchemaCreation,resourceChangedPaths,checkResourceRegistration} from '../test-preflight.mjs';
const identity={database:'dx_rework_ci',username:'dx_rework_test',databaseOid:'42',serverVersion:'160015',marker:'dx-rework-isolated-test-v1'};
const context={head:'a'.repeat(40),base:'b'.repeat(40),runId:'12',attempt:'1',identities:{default:identity},node:'22.22.2'};
const maintenanceIdentity={database:'dx_rework_main_0232_test',username:'dx_rework_test',marker:'dx-rework-isolated-test-v1',databaseOid:'43',serverVersion:'160015',port:'5432',address:'127.0.0.1',allowConnections:true,isTemplate:false,isSuperuser:false,canCreateDatabase:false,canCreateRole:false,canReplicate:false,canBypassRls:false};
const maintenanceUrl='postgresql://dx_rework_test@127.0.0.1:5432/dx_rework_main_0232_test',maintenanceAdminUrl='postgresql://postgres@127.0.0.1:5432/dx_rework_main_0232_test';
const maintenanceIdentities={default:{...identity,port:'5432',address:'127.0.0.1'},'main-maintenance':maintenanceIdentity};
const maintenanceEnvironment=dir=>({DX_REWORK_TEST_RUN_ID:'1234abcd',DX_REWORK_TEST_RESOURCE_MANIFEST_DIR:dir,DX_REWORK_TEST_RESOURCE_IDENTITIES:JSON.stringify(maintenanceIdentities),DX_REWORK_TEST_SCHEMA_CLEANUP:'after-workers',MAIN_0232_TEST_DATABASE_URL:maintenanceUrl,MAIN_0232_TEST_ADMIN_DATABASE_URL:maintenanceAdminUrl});
test('maintenance fixture cannot start an unowned migration through a direct CLI entry',()=>{
 const output=execFileSync(process.execPath,['tests/fixtures/main-0232-maintenance.mjs'],{encoding:'utf8',env:{...process.env,NODE_ENV:'test',DATABASE_URL:'',TEST_DATABASE_URL:'postgresql://unused@never-connect.invalid/test',TEST_ADMIN_DATABASE_URL:'postgresql://unused@never-connect.invalid/test',MAIN_0232_EXPECTED_PG_MAJOR:'13'}});
 assert.equal(output,'');
});
function maintenanceQueryable(live=maintenanceIdentity,state={present:true,occupied:false}){
 const queries=[];
 return {queries,async query(sql){
  queries.push(sql);
  if(sql.includes('FROM pg_database database'))return {rows:[{database:live.database,username:live.username,marker:live.marker,database_oid:live.databaseOid,server_version:live.serverVersion,port:live.port,address:live.address,allow_connections:live.allowConnections,is_template:live.isTemplate,is_superuser:live.isSuperuser,can_create_database:live.canCreateDatabase,can_create_role:live.canCreateRole,can_replicate:live.canReplicate,can_bypass_rls:live.canBypassRls}]};
  if(sql.includes("to_regnamespace('public')"))return {rows:[state]};
  throw Error('UNEXPECTED_MAINTENANCE_QUERY');
 }};
}
async function withMaintenanceFixture(check){
 const dir=mkdtempSync(join(tmpdir(),'dx-maintenance-contract-')),previousNodeEnv=process.env.NODE_ENV;
 process.env.NODE_ENV='test';
 try{await check(dir,maintenanceEnvironment(dir));}
 finally{if(previousNodeEnv===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=previousNodeEnv;rmSync(dir,{recursive:true,force:true});}
}

test('main maintenance target requires a distinct loopback database and the exact registered identity',()=>{
 assert.doesNotThrow(()=>assertMainMaintenanceTarget(maintenanceUrl,maintenanceAdminUrl,maintenanceIdentities));
 const rejected=[
  [maintenanceUrl.replace('127.0.0.1','192.0.2.1'),maintenanceAdminUrl.replace('127.0.0.1','192.0.2.1'),maintenanceIdentities],
  [maintenanceUrl.replace('dx_rework_main_0232_test','dx_rework_ci'),maintenanceAdminUrl.replace('dx_rework_main_0232_test','dx_rework_ci'),maintenanceIdentities],
  [maintenanceUrl,maintenanceAdminUrl.replace(':5432',':5433'),maintenanceIdentities],
  [maintenanceUrl,maintenanceAdminUrl.replace('dx_rework_main_0232_test','dx_rework_ci'),maintenanceIdentities],
  [maintenanceUrl.replace('postgresql:','https:'),maintenanceAdminUrl,maintenanceIdentities],
  [maintenanceUrl,maintenanceAdminUrl,{default:identity}],
  ...[{database:'dx_rework_ci'},{username:'another_role'},{databaseOid:''},{marker:'unmarked'}].map(change=>[maintenanceUrl,maintenanceAdminUrl,{...maintenanceIdentities,'main-maintenance':{...maintenanceIdentity,...change}}]),
  [maintenanceUrl,maintenanceAdminUrl,{...maintenanceIdentities,default:{...maintenanceIdentity,database:'dx_rework_ci'}}],
 ];
 for(const args of rejected)assert.throws(()=>assertMainMaintenanceTarget(...args),/TEST_MAINTENANCE_TARGET_REJECTED/);
 assert.throws(()=>ownedPostgresSchema('resource_smoke','main-maintenance',{}),/TEST_RESOURCE_TARGET_REJECTED/);
});

test('main maintenance public claim records one exclusive receipt after read-only identity and emptiness checks',async()=>{
 await withMaintenanceFixture(async(dir,environment)=>{
  const pool=maintenanceQueryable();await claimMainMaintenancePublic(pool,environment);
  const resources=readOwnedResources(dir,environment.DX_REWORK_TEST_RUN_ID,maintenanceIdentities);
  assert.deepEqual(resources,[{version:1,kind:'main-maintenance-public',runId:'1234abcd',schema:'public',databaseTarget:'main-maintenance',identity:maintenanceIdentity}]);
  assert.equal(pool.queries.length,2);assert.ok(pool.queries.every(sql=>/^\s*SELECT\b/.test(sql)));
  const receipt=readFileSync(join(dir,'main-maintenance-1234abcd.json'),'utf8');
  await assert.rejects(()=>claimMainMaintenancePublic(pool,environment),{code:'EEXIST'});
  assert.equal(readFileSync(join(dir,'main-maintenance-1234abcd.json'),'utf8'),receipt);
 });
});

test('main maintenance claim rejects absent cleanup ownership and changed live identity before writing a receipt',async()=>{
 await withMaintenanceFixture(async(dir,environment)=>{
  const neverQuery={query(){throw Error('MUST_NOT_QUERY');}};
  for(const change of [{DX_REWORK_TEST_RUN_ID:undefined},{DX_REWORK_TEST_RESOURCE_MANIFEST_DIR:undefined},{DX_REWORK_TEST_SCHEMA_CLEANUP:'immediate'}])await assert.rejects(()=>claimMainMaintenancePublic(neverQuery,{...environment,...change}),/TEST_RESOURCE_CLEANUP_OWNER_REQUIRED/);
  await assert.rejects(()=>claimMainMaintenancePublic(neverQuery,{...environment,MAIN_0232_TEST_DATABASE_URL:maintenanceUrl.replace('127.0.0.1','192.0.2.1')}),/TEST_MAINTENANCE_TARGET_REJECTED/);
  const changed=maintenanceQueryable({...maintenanceIdentity,databaseOid:'99'});
  await assert.rejects(()=>claimMainMaintenancePublic(changed,environment),/TEST_RESOURCE_LIVE_IDENTITY_CHANGED/);
  assert.equal(changed.queries.length,1);assert.deepEqual(readdirSync(dir),[]);
 });
});

test('main maintenance public claim rejects a missing or occupied public schema',async()=>{
 await withMaintenanceFixture(async(dir,environment)=>{
  for(const state of [{present:false,occupied:false},{present:true,occupied:true}]){
   const pool=maintenanceQueryable(maintenanceIdentity,state);
   await assert.rejects(()=>claimMainMaintenancePublic(pool,environment),/TEST_MAINTENANCE_FRESH_PUBLIC_REQUIRED/);
   assert.equal(pool.queries.length,2);assert.deepEqual(readdirSync(dir),[]);
  }
 });
});

test('main maintenance receipts cannot change run, target, public schema, kind, filename or live identity',()=>{
 const dir=mkdtempSync(join(tmpdir(),'dx-maintenance-receipt-')),runId='1234abcd',name='main-maintenance-'+runId+'.json';
 const receipt={version:1,kind:'main-maintenance-public',runId,schema:'public',databaseTarget:'main-maintenance',identity:maintenanceIdentity};
 try{
  writeFileSync(join(dir,name),JSON.stringify(receipt));assert.deepEqual(readOwnedResource(dir,name,runId,maintenanceIdentities),receipt);
  for(const change of [{version:2},{runId:'ffffffff'},{schema:'resource_smoke_'+runId+'0'.repeat(24)},{databaseTarget:'default'},{kind:'postgres-schema'},{identity:{...maintenanceIdentity,databaseOid:'99'}}]){
   writeFileSync(join(dir,name),JSON.stringify({...receipt,...change}));
   assert.throws(()=>readOwnedResource(dir,name,runId,maintenanceIdentities),/TEST_RESOURCE_(?:MANIFEST_REJECTED|UNREGISTERED)/);
  }
  writeFileSync(join(dir,name),JSON.stringify(receipt));
  assert.throws(()=>readOwnedResource(dir,name,'ffffffff',maintenanceIdentities),/TEST_RESOURCE_MANIFEST_REJECTED/);
  assert.throws(()=>readOwnedResource(dir,name,runId,{...maintenanceIdentities,'main-maintenance':{...maintenanceIdentity,databaseOid:'99'}}),/TEST_RESOURCE_MANIFEST_REJECTED/);
  const renamed='main-maintenance-ffffffff.json';writeFileSync(join(dir,renamed),JSON.stringify(receipt));
  assert.throws(()=>readOwnedResource(dir,renamed,runId,maintenanceIdentities),/TEST_RESOURCE_MANIFEST_REJECTED/);
  const schema='resource_smoke_'+runId+'0'.repeat(24),ordinaryName=schema+'.json';
  writeFileSync(join(dir,ordinaryName),JSON.stringify({...receipt,kind:'postgres-schema',schema}));
  assert.throws(()=>readOwnedResource(dir,ordinaryName,runId,maintenanceIdentities),/TEST_RESOURCE_(?:TARGET_REJECTED|MANIFEST_REJECTED)/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('0232 maintenance actually enters the canonical Full plan once and uses the isolated single-worker configuration',async()=>{
 const file='tests/integration/main-0232-maintenance-postgres.test.ts',risk=classifyFullGatePaths(['scripts/deploy/main-maintenance-plans.json']);
 const full=fullGatePostgresPlan({DB_REQUIRED:String(risk.dbRequired),BUSINESS_CHAIN_SENSITIVE:String(risk.businessChainSensitive),MIGRATION_SENSITIVE:String(risk.migrationSensitive),DEPLOYMENT_SENSITIVE:String(risk.deploymentSensitive),MAPPED_POSTGRES_TESTS:[...risk.mappedPostgresTests,file,file].join(','),BASE_SHA:'b'.repeat(40)});
 const selected=full.plan.filter(row=>row.path===file);
 assert.equal(selected.length,1);assert.deepEqual(selected[0].memberships,['mapped','chain']);
 assert.equal(selected[0].config,'vitest.postgres-immediate.config.ts');
 assert.equal(postgresPlan({chain:true}).filter(row=>row.path===file).length,1);
 const {default:configuration}=await import('../../vitest.postgres-immediate.config.ts');
 assert.equal(configuration.test.maxWorkers,testExecutionConfig.workers.postgres);assert.equal(configuration.test.maxWorkers,1);
});

test('local and CI resolve one canonical union; long correctness uses finite config, ordinary/performance keeps defaults',()=>{
 const mapped=[POSTGRES_CHAIN_TESTS[0],POSTGRES_CHAIN_TESTS[0],'tests/integration/access-postgres.test.ts'];
 const plan=postgresPlan({mapped,chain:true});assert.equal(plan.filter(r=>r.path===mapped[0]).length,1);assert.deepEqual(plan.find(r=>r.path===mapped[0]).memberships,['mapped','chain']);assert.equal(plan.length,POSTGRES_CHAIN_TESTS.length+1);
 assert.equal(configForSuite(POSTGRES_CHAIN_TESTS[0]),'vitest.postgres-immediate.config.ts');assert.equal(configForSuite(mapped[2]),'vitest.config.ts');
 const workflow=readFileSync('.github/workflows/full-gate.yml','utf8'),pkg=JSON.parse(readFileSync('package.json','utf8'));
 assert.ok(workflow.includes(pkg.scripts['test:postgres']));assert.ok(pkg.scripts.check.includes('npm run build --workspaces --if-present'));assert.ok(pkg.scripts.check.includes('node node_modules/vitest/vitest.mjs run'));assert.ok(!pkg.scripts.check.includes('npm run test &&'));assert.ok(pkg.scripts.check.includes('--static-already-validated'));assert.ok(workflow.includes('--full-gate --verify-receipt'));
 const defaultConfig=readFileSync('vitest.config.ts','utf8');
 assert.doesNotMatch(defaultConfig,/testTimeout/);assert.match(defaultConfig,/exclude: process.env.DX_REWORK_TEST_SUITE_KIND === "postgres" \? \[\] : postgresTestFiles\(\)/);
});
test('Root audit composition is explicit: shared supplier/wage suites execute exactly once and each needs real results',()=>{
 const plan=postgresPlan({mapped:ROOT_AUDIT_TESTS.slice(1),chain:true,rootAudit:true});
 for(const file of ROOT_AUDIT_TESTS)assert.equal(plan.filter(row=>row.path===file).length,1);
 assert.doesNotMatch(readFileSync(ROOT_AUDIT_TESTS[0],'utf8'),/^import ["']\.\/.*\.test\.js/m);
});
test('executed coverage rejects empty/all skipped, missing, repeated, failed and foreign suites',()=>{
 const file=POSTGRES_CHAIN_TESTS[0],valid={success:true,numFailedTests:0,numFailedTestSuites:0,testResults:[{name:'/repo/'+file,status:'passed',assertionResults:[{status:'passed'}]}]};
 assertSuiteResults(valid,[file]);assert.throws(()=>assertSuiteResults({...valid,testResults:[]},[]),/EMPTY_PLAN/);
 for(const report of [{...valid,success:false},{...valid,numFailedTests:1},{...valid,testResults:[]},{...valid,testResults:[...valid.testResults,...valid.testResults]},{...valid,testResults:[{...valid.testResults[0],assertionResults:[{status:'pending'}]}]}])assert.throws(()=>assertSuiteResults(report,[file]));
 const plan=postgresPlan({mapped:[file]}),receipt={version:1,status:'passed',cleanup:'passed',context,plan,results:valid,fingerprint:executionFingerprint(context,plan)};
 assertExecutionReceipt(receipt,context,plan);
 for(const changed of [{...context,head:'c'.repeat(40)},{...context,base:'d'.repeat(40)},{...context,attempt:'2'},{...context,identities:{default:{...identity,serverVersion:'130023'}}},{...context,identities:{default:{...identity,username:'other_role'}}}])assert.throws(()=>assertExecutionReceipt(receipt,changed,plan));
 assert.throws(()=>assertExecutionReceipt({...receipt,cleanup:'failed'},context,plan));
});
test('one resource registry admits every created prefix and binds exact run, target and live DB identity',()=>{
 const dir=mkdtempSync(join(tmpdir(),'dx-contract-')),environment={DX_REWORK_TEST_RUN_ID:'1234abcd',DX_REWORK_TEST_RESOURCE_MANIFEST_DIR:dir,DX_REWORK_TEST_RESOURCE_IDENTITIES:JSON.stringify({default:identity})};
 try{
  for(const prefix of SCHEMA_PREFIXES){const schema=ownedPostgresSchema(prefix,'default',environment);assert.match(schema,/[0-9a-f]{32}$/);assert.ok(schema.length<=63);}
  const resources=readOwnedResources(dir,'1234abcd',{default:identity});assert.equal(resources.length,SCHEMA_PREFIXES.length);
  assert.throws(()=>ownedPostgresSchema('not_registered','default',environment),/UNREGISTERED/);
  assert.throws(()=>ownedPostgresSchema('sample','acceptance-clock',environment),/TARGET/);
  assert.throws(()=>ownedPostgresSchema('sample','default',{...environment,DX_REWORK_TEST_RESOURCE_IDENTITIES:'{}'}),/IDENTITY/);
  assert.throws(()=>readOwnedResources(dir,'ffffffff',{default:identity}));
  assert.throws(()=>readOwnedResources(dir,'1234abcd',{default:{...identity,databaseOid:'43'}}));
  const r=resources[0],path=join(dir,r.schema+'.json');writeFileSync(path,JSON.stringify({...r,databaseTarget:'arbitrary'}));assert.throws(()=>readOwnedResources(dir,'1234abcd',{default:identity}));
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('migration inventory retains real upgrade/ACL/recovery without unrelated activation or transfer; unknown deploy logic stays conservative',()=>{
 for(const path of ['apps/api/migrations/9999_new.sql','scripts/deploy/acceptance-migration-requirements.json']){const r=classifyFullGatePaths([path]);assert.ok(r.migrationSensitive&&r.maintenanceSensitive&&r.businessChainSensitive);assert.equal(r.activationSensitive,false);assert.equal(r.transferSensitive,false);}
 for(const path of ['scripts/deploy/update-acceptance-local.sh','scripts/deploy/unknown-new-executor.sh','.github/workflows/full-gate.yml']){const r=classifyFullGatePaths([path]);assert.ok(r.maintenanceSensitive&&r.activationSensitive&&r.transferSensitive);}
 assert.equal(classifyFullGatePaths(['scripts/deploy/package-release.sh']).maintenanceSensitive,false);
 assert.equal(classifyFullGatePaths(['scripts/deploy/activate-release.sh']).activationSensitive,true);
});
test('each managed creation is constrained: one registered call cannot hide a second bare CREATE',async()=>{
 const managed="const schema=ownedPostgresSchema('sample'); await createOwnedPostgresSchema(pool,schema);";
 assert.doesNotThrow(()=>assertManagedSchemaCreation(managed,'fixture.ts'));
 assert.throws(()=>assertManagedSchemaCreation(managed+' const historySchema=randomUUID(); await pool.query(`CREATE SCHEMA ${historySchema}`);','fixture.ts'),/NOT_REGISTERED/);
 assert.throws(()=>assertManagedSchemaCreation(managed+' await client.query("create \n schema raw");','fixture.ts'),/NOT_REGISTERED/);
 await assert.rejects(()=>createOwnedPostgresSchema({query:()=>{throw Error('MUST_NOT_QUERY');}},'resource_smoke_'+'f'.repeat(32)),/NOT_CREATED/);
});
test('bare schema DDL rejects actual escaped TS/JS source, including String.raw',()=>{
 const prefix="const schema=ownedPostgresSchema('sample'); await createOwnedPostgresSchema(pool,schema); ";
 const sources=[
  String.raw`await pool.query("CREATE\nSCHEMA history_unregistered");`,
  String.raw`await pool.query("CREATE\r\nSCHEMA history_unregistered");`,
  String.raw`await pool.query("CRE\u0041TE\u0020SCHE\x4dA history_unregistered");`,
  String.raw`await pool.query("CR\EATE SCHEMA history_unregistered");`,
  String.raw`await pool.query("CRE" + "ATE\nSCHEMA history_unregistered");`,
  'await pool.query(String.raw`CREATE'+String.raw`\n`+'SCHEMA history_unregistered`);',
 ];
 assert.ok(sources[0].includes(String.raw`\n`));assert.equal(sources[0].includes('\n'),false);
 for(const source of sources)assert.throws(()=>assertManagedSchemaCreation(prefix+source,'fixture.ts'),/NOT_REGISTERED/);
});
test('local preflight observes staged, unstaged and untracked fixture changes',()=>{
 const dir=mkdtempSync(join(tmpdir(),'dx-staged-resource-')),git=(...args)=>execFileSync('git',['-C',dir,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 try{
  git('init','-q');git('config','user.name','TEST');git('config','user.email','test@example.invalid');writeFileSync(join(dir,'base'),'base');git('add','.');git('commit','-qm','base');const base=git('rev-parse','HEAD');
  mkdirSync(join(dir,'tests'));const staged='tests/staged-fixture.ts',untracked='tests/untracked-fixture.ts';writeFileSync(join(dir,staged),'CREATE SCHEMA bare');git('add',staged);writeFileSync(join(dir,untracked),'CREATE SCHEMA bare');
  for(const ref of [null,base]){const changed=resourceChangedPaths(dir,ref);assert.ok(changed.has(staged));assert.ok(changed.has(untracked));}
  writeFileSync(join(dir,'base'),'unstaged');assert.ok(resourceChangedPaths(dir,null).has('base'));
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('Full PG requires explicit risk context and a nonempty execution; no-DB scope is never a PG pass',()=>{
 const valid={DB_REQUIRED:'true',BUSINESS_CHAIN_SENSITIVE:'false',MIGRATION_SENSITIVE:'false',DEPLOYMENT_SENSITIVE:'false',MAPPED_POSTGRES_TESTS:POSTGRES_CHAIN_TESTS[0],BASE_SHA:'b'.repeat(40)};
 assert.equal(fullGatePostgresPlan(valid).plan.length,1);
 for(const key of Object.keys(valid)){const bad={...valid};delete bad[key];assert.throws(()=>fullGatePostgresPlan(bad),/RISK_CONTEXT/);}
 assert.throws(()=>fullGatePostgresPlan({...valid,MAPPED_POSTGRES_TESTS:''}),/EMPTY_PLAN/);
 assert.throws(()=>fullGatePostgresPlan({...valid,DB_REQUIRED:'false'}),/CONTRADICTION/);
 assert.equal(fullGatePostgresPlan({...valid,DB_REQUIRED:'false',MAPPED_POSTGRES_TESTS:''}).status,'not-applicable');
});

test('migration static preflight actually runs before dependencies in a fresh source-only snapshot',()=>{
 const dir=mkdtempSync(join(tmpdir(),'dx-source-only-migrations-'));
 try{
  for(const path of ['package.json','scripts/check-migrations.mjs','scripts/migration-lib.mjs','scripts/migration-history-policy.mjs','scripts/migration-branches.json','scripts/migration-main-extensions.json','apps/api/migrations','apps/api/src/platform/migration-manifest.json']){
   const target=join(dir,path);mkdirSync(dirname(target),{recursive:true});cpSync(path,target,{recursive:true});
  }
  assert.equal(existsSync(join(dir,'node_modules')),false);
  const result=JSON.parse(execFileSync(process.execPath,[join(dir,'scripts/check-migrations.mjs')],{cwd:dir,encoding:'utf8',stdio:['ignore','pipe','pipe']}));
  assert.equal(result.success,true);assert.equal(result.migrations.length,JSON.parse(readFileSync('apps/api/src/platform/migration-manifest.json','utf8')).migrations.length);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('immediate deletion is a separate single-worker stage, without changing its absence assertion',()=>{
 const file='tests/integration/rework-postgres.test.ts',plan=postgresPlan({mapped:[file],chain:true});assert.equal(plan.filter(r=>r.path===file).length,1);assert.equal(configForSuite(file),'vitest.postgres-immediate.config.ts');
 const runner=readFileSync('scripts/run-business-chain-gate.mjs','utf8');assert.ok(runner.includes("['vitest.config.ts','vitest.postgres-immediate.config.ts','vitest.business-chain.config.ts']"));
 const config=readFileSync('vitest.postgres-immediate.config.ts','utf8');assert.ok(config.includes('maxWorkers:testExecutionConfig.workers.postgres'));
});

test('every existing domain mapping remains runnable under managed-resource preflight',()=>{
 const selected=classifyFullGatePaths(['apps/api/src/access/service.ts','apps/api/src/auth/session.ts','apps/api/src/wages/service.ts','apps/api/src/tools/service.ts','apps/api/src/receiving/service.ts','apps/api/src/access/supplier-service.ts']).mappedPostgresTests;
 assert.deepEqual([...EXISTING_MAPPED_POSTGRES_TESTS].sort(),selected);
 for(const path of selected)assert.doesNotThrow(()=>assertManagedSchemaCreation(readFileSync(path,'utf8'),path));
 assert.doesNotThrow(()=>checkResourceRegistration());
});

test('SQL-heavy full business fixture is isolated while other long suites remain bounded parallel',()=>{
 const full='tests/integration/full-business-chain-postgres.test.ts',peer=POSTGRES_CHAIN_TESTS.find(path=>path!==full);
 const plan=postgresPlan({mapped:[full],chain:true});
 assert.equal(plan.filter(row=>row.path===full).length,1);assert.equal(configForSuite(full),'vitest.postgres-immediate.config.ts');
 assert.equal(configForSuite(peer),'vitest.business-chain.config.ts');
 const source=readFileSync(full,'utf8');assert.ok(source.includes('timeout: 60_000'));
 const config=readFileSync('vitest.business-chain.config.ts','utf8');assert.ok(config.includes('testExecutionConfig.workers.longCorrectness'));
});
