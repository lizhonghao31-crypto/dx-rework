import assert from 'node:assert/strict';
import {test} from 'node:test';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,readFileSync,writeFileSync,rmSync,mkdirSync,cpSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {postgresPlan,configForSuite,assertSuiteResults,assertExecutionReceipt,executionFingerprint,fullGatePostgresPlan,POSTGRES_CHAIN_TESTS,ROOT_AUDIT_TESTS} from '../test-suite-plan.mjs';
import {ownedPostgresSchema,createOwnedPostgresSchema,readOwnedResources,SCHEMA_PREFIXES} from '../test-resource-contract.mjs';
import {classifyFullGatePaths} from './full-gate-risk-map.mjs';
import {worktreeSnapshot,inspectCompatibility} from '../check-main-release-compat.mjs';
import {assertManagedSchemaCreation,resourceChangedPaths} from '../test-preflight.mjs';
import {reconcileTimeInventory} from '../acceptance/time-site-inventory.mjs';
const identity={database:'dx_rework_ci',username:'dx_rework_test',databaseOid:'42',serverVersion:'160015',marker:'dx-rework-isolated-test-v1'};
const context={head:'a'.repeat(40),base:'b'.repeat(40),runId:'12',attempt:'1',identities:{default:identity},node:'22.22.2'};
test('local and CI resolve one canonical union; long correctness uses finite config, ordinary/performance keeps defaults',()=>{
 const mapped=[POSTGRES_CHAIN_TESTS[0],POSTGRES_CHAIN_TESTS[0],'tests/integration/access-postgres.test.ts'];
 const plan=postgresPlan({mapped,chain:true});assert.equal(plan.filter(r=>r.path===mapped[0]).length,1);assert.deepEqual(plan.find(r=>r.path===mapped[0]).memberships,['mapped','chain']);assert.equal(plan.length,POSTGRES_CHAIN_TESTS.length+1);
 assert.equal(configForSuite('tests/integration/development-technical-postgres.test.ts'),'vitest.business-chain.config.ts');assert.equal(configForSuite(mapped[2]),'vitest.config.ts');
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
test('main additions are explicit unverified release work; actual source unknown identity/checksum/history still rejects',async()=>{
 const candidate=worktreeSnapshot(process.cwd()),manifest='apps/api/src/platform/migration-manifest.json',rows=JSON.parse(candidate.read(manifest)).migrations;
 const mainLane=new Set([...JSON.parse(candidate.read('scripts/migration-branches.json')).main,...JSON.parse(candidate.read('scripts/migration-main-extensions.json'))].map(r=>r.version));
 const sql='-- isolated future main fixture\nSELECT 1;\n',version='0999_future_main_fixture',extra={version,checksum:createHash('sha256').update(sql).digest('hex')};
 const mainRows=[...rows.filter(r=>Number(r.version.slice(0,4))<=217||mainLane.has(r.version)),extra];
 const main={sha:'c'.repeat(40),read:path=>path===manifest?JSON.stringify({migrations:mainRows}):path.endsWith(version+'.sql')?sql:candidate.read(path),paths:()=>mainRows.map(r=>'apps/api/migrations/'+r.version+'.sql')};
 const integration=await inspectCompatibility({main,candidate,baseline:candidate,intent:'integration'});assert.equal(integration.passed,true);assert.equal(integration.releaseTodos[0].version,version);assert.equal(integration.mainCompatibility.productionPromotionVerified,false);
 assert.equal((await inspectCompatibility({main,candidate,intent:'acceptance'})).passed,true);
 const production=await inspectCompatibility({main,candidate,intent:'production'});assert.equal(production.passed,false);assert.equal(production.mainCompatibility.status,'BLOCKED_INVALID_SOURCE');
 for(const history of [[extra],[{...rows[0],checksum:'f'.repeat(64)}],rows.slice(1)]){
  const baseline={...candidate,read:path=>path===manifest?JSON.stringify({migrations:history}):candidate.read(path),paths:()=>history.map(r=>'apps/api/migrations/'+r.version+'.sql')};
  let rejected=false;try{rejected=!(await inspectCompatibility({main,candidate,baseline,intent:'integration'})).passed;}catch{rejected=true;}assert.equal(rejected,true);
 }
});
test('inventory reconciliation preserves every unchanged manual semantic field',()=>{
 const old={sourceBase:'exact-source',entries:[{path:'unchanged',owner:'human',semanticStatus:'reviewed',evidence:'retained',sites:[[1,'wall','hash']]}]};
 const next=reconcileTimeInventory(old,[{path:'unchanged',owner:'generated',sites:[{line:9,kind:'wall',sourceSha256:'hash'}]}]);assert.deepEqual(next,old);
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
  for(const path of ['package.json','scripts/check-migrations.mjs','scripts/migration-lib.mjs','scripts/migration-history-policy.mjs','scripts/migration-branches.json','scripts/migration-main-extensions.json','scripts/deploy/migration-execution-compatibility.mjs','scripts/deploy/migration-execution-compatibility.json','apps/api/migrations','apps/api/src/platform/migration-manifest.json']){
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

test('SQL-heavy full business fixture is isolated while other long suites remain bounded parallel',()=>{
 const full='tests/integration/full-business-chain-postgres.test.ts',peer=POSTGRES_CHAIN_TESTS.find(path=>path!==full);
 const plan=postgresPlan({mapped:[full],chain:true});
 assert.equal(plan.filter(row=>row.path===full).length,1);assert.equal(configForSuite(full),'vitest.postgres-immediate.config.ts');
 assert.equal(configForSuite(peer),'vitest.business-chain.config.ts');
 const source=readFileSync(full,'utf8');assert.ok(source.includes('timeout: 60_000'));
 const config=readFileSync('vitest.business-chain.config.ts','utf8');assert.ok(config.includes('testExecutionConfig.workers.longCorrectness'));
});
