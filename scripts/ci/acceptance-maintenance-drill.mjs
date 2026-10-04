#!/usr/bin/env node
// Never accepts a database URL: all privileged setup is confined to a fresh,
// labelled loopback-only Docker container owned by this invocation.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,mkdirSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout} from 'node:timers/promises';
import pg from 'pg';
import {discoverValidatedMigrations} from '../migration-lib.mjs';
import {DigitalProductionIdentityService} from '../../apps/api/dist/production-platform/identity-service.js';
import {DigitalBudgetService} from '../../apps/api/dist/production-platform/budget-service.js';

const repo=resolve(fileURLToPath(new URL('../..',import.meta.url)));
const pgMajor=process.argv[2]??'16';
assert.ok(process.argv.length<=3&&['13','15','16'].includes(pgMajor),'Usage: acceptance-maintenance-drill.mjs [13|15|16]');
const scratch=mkdtempSync(join(tmpdir(),'dx-acceptance-drill-'));
const container=`dx-acceptance-drill-${randomUUID()}`;
const password=randomUUID();
const owner='dx_rework_acceptance', app='dx_rework_acceptance_app';
const database='dx_rework_acceptance', drill='dx_rework_drill_acceptance';
const manifest=JSON.parse(readFileSync(join(repo,'apps/api/src/platform/migration-manifest.json')));
const target=manifest.migrations.at(-1);
const requirements=JSON.parse(readFileSync(join(repo,'scripts/deploy/acceptance-migration-requirements.json')));
const pythonImage='python:3.6.15-slim';
let admin, db, appDb, started=false, passed=false;
const docker=(args,options={})=>execFileSync('docker',args,{encoding:'utf8',stdio:['pipe','pipe','pipe'],maxBuffer:20*1024*1024,...options});
const report=message=>process.stdout.write(`ACCEPTANCE_DRILL PG${pgMajor} ${message}\n`);
function execute(file,label,ok=true) {
 const result=spawnSync('docker',['exec',container,'psql','-XqAt','-U','postgres','-d',database,'-f',file],{encoding:'utf8',maxBuffer:20*1024*1024});
 writeFileSync(join(scratch,`${label}.log`),result.stdout+result.stderr);
 if(ok)assert.equal(result.status,0,(result.stderr+result.stdout).slice(-8000));
 else assert.notEqual(result.status,0,'Expected fail-closed rejection');
 return result;
}
async function generate(mode='apply',tool=repo) {
 const identity=(await db.query("SELECT current_database() AS database,current_setting('port')::int AS port,(SELECT oid::bigint FROM pg_database WHERE datname=current_database()) AS oid")).rows[0];
 identity.oid=Number(identity.oid);identity.address='127.0.0.1';
 writeFileSync(join(scratch,'identity.json'),JSON.stringify(identity));
 const file=join(scratch,mode+'.sql');
 docker(['run','--rm','--network','none','-v',`${repo}:${repo}:ro`,'-v',`${scratch}:${scratch}`,pythonImage,'python','-B',join(repo,'scripts/deploy/prepare-acceptance-migration.py'),repo,join(scratch,'identity.json'),'/usr/local/bin/node',join(scratch,'history.json'),file,mode,tool]);
 return file;
}
try {
 docker(['run','--rm','-d','--name',container,'--label','dx-rework.test=acceptance-maintenance-v1','-e',`POSTGRES_PASSWORD=${password}`,'-p','127.0.0.1::5432','-v',`${repo}:${repo}:ro`,'-v',`${scratch}:${scratch}`,'-v',`${realpathSync(process.execPath)}:/usr/local/bin/node:ro`,pgMajor==='13'?'postgres:13.23':`postgres:${pgMajor}-bookworm`]);started=true;
 const info=JSON.parse(docker(['inspect',container]))[0];
 assert.equal(info.Config.Labels['dx-rework.test'],'acceptance-maintenance-v1');
 const binding=info.NetworkSettings.Ports['5432/tcp'][0];assert.equal(binding.HostIp,'127.0.0.1');
 let ready=0;
 for(let i=0;i<60&&ready<3;i++) {
  const result=spawnSync('docker',['exec',container,'pg_isready','-U','postgres','-d','postgres'],{stdio:'ignore'});
  ready=result.status===0?ready+1:0;await setTimeout(1000);
 }
 assert.equal(ready,3,'Isolated PostgreSQL did not start');
 const url=(role,name)=>`postgresql://${role}:${password}@127.0.0.1:${binding.HostPort}/${name}`;
 admin=new pg.Client({connectionString:url('postgres','postgres')});await admin.connect();
 for(const role of [owner,app])await admin.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
 // A real non-inheriting membership distinguishes absent PG15 options from
 // PG16 false/true options without granting either runtime role extra access.
 await admin.query(`CREATE ROLE diagnostic_probe NOLOGIN; ALTER ROLE ${app} NOINHERIT; GRANT diagnostic_probe TO ${app}`);
 await admin.query(`CREATE DATABASE ${database} OWNER ${owner}`);
 db=new pg.Client({connectionString:url('postgres',database)});await db.connect();await db.query(`SET ROLE ${owner}`);
 await db.query('CREATE TABLE schema_migrations(version text PRIMARY KEY,checksum char(64) NOT NULL,applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)');
 const catalog=await discoverValidatedMigrations();
 const historical=JSON.parse(readFileSync(join(repo,'tests/fixtures/migration-histories/digital-da6590cc.json'))).migrations.slice(0,225);
 for(const row of historical) {
  const migration=catalog.find(x=>x.version===row.version);assert.equal(migration.checksum,row.checksum);
  await db.query('BEGIN');await db.query(migration.sql);await db.query('INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)',[row.version,row.checksum]);await db.query('COMMIT');
 }
 const sentinel=randomUUID();await db.query("INSERT INTO app_users(id,display_name,enabled) VALUES($1,'TEST retained migration fixture',true)",[sentinel]);
 // Existing runtime/backup access is a fixture assumption, not an exported site ACL.
 for(const {name} of (await db.query("SELECT relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v') AND relname<>'sourcing_contract_return_submissions'")).rows)await db.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON "${name}" TO ${app}`);
 await db.query(`GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO ${app}`);
 await db.query('RESET ROLE');
 await db.query(`ALTER TABLE sourcing_contract_return_submissions OWNER TO ${app}; ALTER TABLE digital_production_notification_events OWNER TO ${app}; ALTER FUNCTION guard_cutting_record_creation() OWNER TO ${app}`);
 const before=(await db.query('SELECT version,checksum,applied_at::text AS applied_at FROM schema_migrations ORDER BY version')).rows;
 assert.equal((await db.query('SELECT count(*)::int n FROM pg_default_acl')).rows[0].n,0);
 assert.equal((await db.query(`SELECT pg_has_role('${app}','${owner}','USAGE') allowed`)).rows[0].allowed,false);
 const preflight=await generate('preflight');
 const rejected=execute(preflight,'mixed-owners',false);
 const roles=rejected.stdout.split('\n').filter(x=>x.startsWith('{')).map(x=>JSON.parse(x)).find(x=>x.maintenance_role);
 assert.ok(roles,'Role diagnostics must precede permission rejection');
 assert.equal(Math.floor(roles.server_version_num/10000),Number(pgMajor));
 assert.equal(roles.application_inherits_maintenance,false);assert.equal(roles.maintenance_inherits_application,false);
 assert.deepEqual(roles.memberships,[{member:app,role:'diagnostic_probe',member_rolinherit:false,inherit:Number(pgMajor)<16?'not_applicable':false,set:Number(pgMajor)<16?'not_applicable':true}]);
 assert.equal((await db.query(`SELECT pg_has_role('${app}','diagnostic_probe','USAGE') allowed`)).rows[0].allowed,false);
 const diagnostics=rejected.stdout.split('\n').filter(x=>x.startsWith('[{')).map(x=>JSON.parse(x)).find(x=>x[0]?.kind);
 assert.ok(diagnostics);
 for(const object of ['sourcing_contract_return_submissions','digital_production_notification_events','guard_cutting_record_creation'])assert.ok(diagnostics.some(x=>x.object===object&&!x.ok),`Missing simultaneous finding ${object}`);
 assert.deepEqual((await db.query('SELECT version,checksum,applied_at::text AS applied_at FROM schema_migrations ORDER BY version')).rows,before);
 assert.equal((await db.query("SELECT to_regclass('digital_budget_documents') AS relation")).rows[0].relation,null);
 report('225 history; three mixed-owner findings returned together; read-only rejection preserved history');
 // End the membership-report fixture before exercising the original runtime
 // and restore fixtures (PG15 NOINHERIT also affects pg_database_owner).
 await admin.query(`REVOKE diagnostic_probe FROM ${app}; ALTER ROLE ${app} INHERIT; DROP ROLE diagnostic_probe`);
 // Explicit fixture repair, never an automatic updater operation.
 await db.query(`BEGIN; ALTER TABLE sourcing_contract_return_submissions OWNER TO ${owner}; GRANT SELECT,INSERT,UPDATE,DELETE ON sourcing_contract_return_submissions TO ${app}; ALTER TABLE digital_production_notification_events OWNER TO ${owner}; GRANT SELECT,INSERT,UPDATE,DELETE ON digital_production_notification_events TO ${app}; ALTER FUNCTION guard_cutting_record_creation() OWNER TO ${owner}; COMMIT;`);
 execute(preflight,'no-default-acl-preflight');
 await db.end();db=null;
 await admin.query(`CREATE DATABASE dx_rework_drill_baseline TEMPLATE ${database}`);
 db=new pg.Client({connectionString:url('postgres',database)});await db.connect();
 // A checksum-bound but accidentally incomplete object inventory must roll back
 // the DDL and grants of that transaction, not silently miss a new table.
 const altered=structuredClone(requirements);altered['0226_digital_production_budgets'].creates=altered['0226_digital_production_budgets'].creates.filter(x=>x!=='digital_budget_image_copies');
 const alteredTool=join(scratch,'altered-tool');mkdirSync(join(alteredTool,'scripts/deploy'),{recursive:true});
 for(const file of ['scripts/migration-history-policy.mjs','scripts/migration-branches.json','scripts/migration-main-extensions.json','scripts/deploy/acceptance-update-policy.mjs'])writeFileSync(join(alteredTool,file),readFileSync(join(repo,file)));
 writeFileSync(join(alteredTool,'scripts/deploy/acceptance-migration-requirements.json'),JSON.stringify(altered));
 const missing=execute(await generate('apply',alteredTool),'inventory-omission',false);
 assert.match(missing.stderr,/Created relations differ/);
 assert.equal((await db.query("SELECT to_regclass('digital_budget_documents') AS relation")).rows[0].relation,null);
 assert.equal((await db.query('SELECT count(*)::int n FROM schema_migrations')).rows[0].n,catalog.filter(x=>x.version<'0226_digital_budget_documents').length);
 await db.end();db=null;await admin.query(`DROP DATABASE ${database}`);await admin.query(`CREATE DATABASE ${database} TEMPLATE dx_rework_drill_baseline OWNER ${owner}`);
 db=new pg.Client({connectionString:url('postgres',database)});await db.connect();
 const oldRelations=(await db.query("SELECT c.relname,c.relowner,c.relacl FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','S') ORDER BY c.relname")).rows;
 const apply=await generate();
 await db.query("CREATE FUNCTION test_interrupt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.version='0227_digital_production_instructions' THEN RAISE EXCEPTION 'TEST intentional interruption'; END IF; RETURN NEW; END $$; CREATE TRIGGER test_interrupt BEFORE INSERT ON schema_migrations FOR EACH ROW EXECUTE FUNCTION test_interrupt()");
 const partial=execute(apply,'partial-commit',false);assert.match(partial.stderr,/TEST intentional interruption/);
 assert.equal((await db.query('SELECT count(*)::int n FROM schema_migrations')).rows[0].n,catalog.filter(x=>x.version<'0227_digital_production_instructions').length);
 assert.equal((await db.query("SELECT to_regclass('digital_instruction_documents') AS relation")).rows[0].relation,null);
 await db.query('DROP TRIGGER test_interrupt ON schema_migrations; DROP FUNCTION test_interrupt()');
 execute(apply,'retry');const after=(await db.query('SELECT version,checksum,applied_at::text AS applied_at FROM schema_migrations ORDER BY version')).rows;
 assert.equal(after.length,manifest.migrations.length);for(const old of before)assert.deepEqual(after.find(x=>x.version===old.version),old);
 execute(apply,'same-schema-repeat');assert.deepEqual((await db.query('SELECT version,checksum,applied_at::text AS applied_at FROM schema_migrations ORDER BY version')).rows,after);
 assert.equal((await db.query('SELECT count(*)::int n FROM pg_default_acl')).rows[0].n,0);
 for(const old of oldRelations)assert.deepEqual((await db.query('SELECT relname,relowner,relacl FROM pg_class WHERE oid=to_regclass($1)',['public.'+old.relname])).rows[0],old,'Existing ownership/ACL must not be rewritten');
 for(const check of Object.values(requirements))for(const seq of check.sequences)assert.equal((await db.query('SELECT pg_get_serial_sequence($1,$2) AS name',['public.'+seq.table,seq.column])).rows[0].name,'public.'+seq.name);
 report('catalog omission rolled back; partial commit before 0227 then retry to current catalog/0233; repeat preserved all timestamps; no default ACL');
 appDb=new pg.Pool({connectionString:url(app,database)});
 const tables=[...new Set(catalog.filter(x=>!historical.some(r=>r.version===x.version)).flatMap(x=>requirements[x.version].creates))];
 for(const table of tables)await appDb.query(`SELECT * FROM ${table} LIMIT 0`);
 const privileges=(await appDb.query("SELECT has_sequence_privilege(current_user,'digital_factory_qc_sequence_seq','SELECT') AS read,has_sequence_privilege(current_user,'digital_factory_qc_sequence_seq','USAGE') AS use")).rows[0];
 assert.deepEqual(privileges,{read:true,use:false});
 // An actual INSERT into the real identity table reaches FK validation rather
 // than a sequence permission error, without disabling any business guard.
 await assert.rejects(appDb.query("INSERT INTO digital_factory_qc(check_id,preparation_id,return_fact_id,line_id,result,problem,treatment,checked_by) VALUES($1,$2,$3,$4,'合格','','',$5)",[randomUUID(),randomUUID(),randomUUID(),randomUUID(),sentinel]),error=>error.code==='23503');
 const actorId=randomUUID();await db.query("INSERT INTO app_users(id,display_name,enabled) VALUES($1,'TEST budget actor',true)",[actorId]);
 const actor={actorId,actorRoles:['root_superuser'],authorizationCapability:'pattern_room:orders:create',authorizationCapabilities:['pattern_room:orders:create'],requestId:randomUUID()};
 const service=new DigitalProductionIdentityService(appDb,true),budget=new DigitalBudgetService(appDb,true);
 const order=await service.createOrder(actor,{customerCode:'PD',productGroup:'男装',designStyleNo:'TEST-MIGRATION',temporaryStyleNo:'TEST-MIGRATION',orderDate:'2026-10-03',lines:[{color:'黑',sizes:[{size:'M',quantity:10}],deliveryDate:'2026-11-01'}]},randomUUID());
 const document={fabricType:'针织',productCategory:'套装',monthSeries:'',date:'2026-10-03',currency:'人民币',rows:[],freight:'0.3',cm:'8.3',salePrice:'48',outsourcingScope:'裁、车、烫、包装',outsourcingUnitPrice:'8.3',imageAttachmentIds:[]};
 const key=randomUUID();assert.equal((await budget.save(actor,order.productionOrderId,{expectedVersion:0,document},key)).version,1);
 assert.equal((await budget.save(actor,order.productionOrderId,{expectedVersion:0,document},key)).version,1);
 assert.equal((await budget.read(actor,order.productionOrderId)).document.cm,'8.3');
 await assert.rejects(()=>budget.save(actor,order.productionOrderId,{expectedVersion:0,document:{...document,cm:'9'}},key),e=>e.statusCode===409);
 report(`low-privilege app read ${tables.length} new tables; budget create/save/read/idempotency/conflict; identity INSERT without USAGE`);
 const runtime=join(scratch,'runtime');mkdirSync(join(runtime,'shared'),{recursive:true});
 const internalUrl=(name)=>`postgresql://${app}:${password}@127.0.0.1:5432/${name}`;
 writeFileSync(join(runtime,'shared/.env'),`DATABASE_URL=${internalUrl(database)}\nAPP_BASE_PATH=/acceptance/\nROOT_DINGTALK_USER_ID=uat-root\nACCEPTANCE_LAB_ENABLED=true\nDIGITAL_PRODUCTION_ENABLED=true\nDIGITAL_PRODUCTION_CREATION_ENABLED=true\nTODO_RUNTIME_ENABLED=false\nTODO_DELIVERY_ENABLED=false\nTODO_TIMING_ENABLED=false\n`,{mode:0o600});
 writeFileSync(join(runtime,'shared/deploy.env'),`DX_REWORK_NODE_BIN=/usr/local/bin/node\nDX_REWORK_PG_BIN_DIR=/usr/lib/postgresql/${pgMajor}/bin\n`,{mode:0o600});
 // The scripts run as container root; fixture configuration must have that
 // owner even when the host runner is an unprivileged UID.
 docker(['exec',container,'chown','0:0',join(runtime,'shared/.env'),join(runtime,'shared/deploy.env')]);
 const envArgs=['-e',`DX_REWORK_ROOT=${runtime}`,'-e',`GIT_SHA=${execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim()}`,'-e',`CURRENT_DATABASE_STATE=${JSON.stringify({count:manifest.migrations.length,version:target.version,checksum:target.checksum})}`,'-e',`TARGET_SCHEMA_VERSION=${target.version}`,'-e',`TARGET_SCHEMA_CHECKSUM=${target.checksum}`];
 const backup=()=>docker(['exec',...envArgs,container,'bash',join(repo,'scripts/backup-postgres.sh')]);
 // Reproduce the previous fix's USAGE-only backup regression, then restore the
 // actual reviewed grant. This fixture-only revoke is never part of deployment.
 await db.query(`REVOKE SELECT ON SEQUENCE digital_factory_qc_sequence_seq FROM ${app}; GRANT USAGE ON SEQUENCE digital_factory_qc_sequence_seq TO ${app}`);
 assert.throws(backup,/digital_factory_qc_sequence_seq/);
 await db.query(`GRANT SELECT ON SEQUENCE digital_factory_qc_sequence_seq TO ${app}; REVOKE USAGE ON SEQUENCE digital_factory_qc_sequence_seq FROM ${app}`);
 const backupLog=backup();writeFileSync(join(scratch,'backup.log'),backupLog);assert.match(backupLog,/"status":"pass"/);
 await admin.query(`CREATE DATABASE ${drill} OWNER ${app}`);
 const restoreScript=`set -euo pipefail
export DX_REWORK_ROOT="$1"
repo="$2"; url="$3"; drill="$4"
source "$repo/scripts/deploy/lib.sh"
load_database_tool_config
fp=$(database_connection_fingerprint "$url")
umask 077
printf 'DX_REWORK_RESTORE_DATABASE_URL=%s\\nDX_REWORK_APPROVED_TARGET_FINGERPRINT=%s\\nDX_REWORK_APPROVED_TARGET_DATABASE=%s\\n' "$url" "$fp" "$drill" > "$DX_REWORK_ROOT/shared/restore.env"
setdir=$(find "$DX_REWORK_ROOT/backups/postgres" -mindepth 1 -maxdepth 1 -type d ! -name '.tmp-*' -print -quit)
DX_REWORK_RESTORE_DRILL=true DX_REWORK_RESTORE_CONFIRM=RESTORE_TO_ISOLATED_DRILL DX_REWORK_RESTORE_MANIFEST="$repo/apps/api/src/platform/migration-manifest.json" bash "$repo/scripts/restore-postgres.sh" "$setdir"
`;
 const restored=docker(['exec','-i',container,'bash','-s','--',runtime,repo,internalUrl(drill),drill],{input:restoreScript});writeFileSync(join(scratch,'restore.log'),restored);assert.match(restored,/restore_drill/);
 const restoredDb=new pg.Client({connectionString:url(app,drill)});await restoredDb.connect();
 try {
  assert.deepEqual((await restoredDb.query('SELECT version,checksum,applied_at::text AS applied_at FROM schema_migrations ORDER BY version')).rows,after);
  assert.equal((await restoredDb.query('SELECT display_name FROM app_users WHERE id=$1',[sentinel])).rows[0].display_name,'TEST retained migration fixture');
  assert.equal((await restoredDb.query('SELECT document FROM digital_budget_documents WHERE production_order_id=$1',[order.productionOrderId])).rows[0].document.cm,'8.3');
 }finally{await restoredDb.end();}
 report('USAGE-only backup failure reproduced; SELECT-only backup and official isolated restore passed, history and business data retained');
 // Also cover every reviewed migration, including IDENTITY columns added to
 // existing tables by 0221 (and the CREATE-then-ALTER form in 0222).
 await appDb.end();appDb=null;await db.end();db=null;
 await admin.query(`DROP DATABASE ${database}`);await admin.query(`CREATE DATABASE ${database} OWNER ${owner}`);
 db=new pg.Client({connectionString:url('postgres',database)});await db.connect();await db.query(`SET ROLE ${owner}`);
 await db.query('CREATE TABLE schema_migrations(version text PRIMARY KEY,checksum char(64) NOT NULL,applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)');
 for(const row of historical.slice(0,217)) {
  const migration=catalog.find(x=>x.version===row.version);
  await db.query('BEGIN');await db.query(migration.sql);await db.query('INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)',[row.version,row.checksum]);await db.query('COMMIT');
 }
 await db.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO ${app}; GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO ${app}`);
 await db.query('RESET ROLE');
 const earlyBefore=(await db.query('SELECT version,checksum,applied_at::text AS applied_at FROM schema_migrations ORDER BY version')).rows;
 const earlyApply=await generate();execute(earlyApply,'early-prefix-217');
 const earlyAfter=(await db.query('SELECT version,checksum,applied_at::text AS applied_at FROM schema_migrations ORDER BY version')).rows;
 assert.equal(earlyAfter.length,manifest.migrations.length);for(const old of earlyBefore)assert.deepEqual(earlyAfter.find(x=>x.version===old.version),old);
 for(const check of Object.values(requirements))for(const seq of check.sequences) {
  assert.equal((await db.query('SELECT pg_get_serial_sequence($1,$2) AS name',['public.'+seq.table,seq.column])).rows[0].name,'public.'+seq.name);
  assert.deepEqual((await db.query(`SELECT has_sequence_privilege('${app}',$1,'SELECT') AS read,has_sequence_privilege('${app}',$1,'USAGE') AS use`,['public.'+seq.name])).rows[0],{read:true,use:false});
 }
 assert.equal((await db.query('SELECT count(*)::int n FROM pg_default_acl')).rows[0].n,0);
 execute(earlyApply,'early-prefix-repeat');
 assert.deepEqual((await db.query('SELECT version,checksum,applied_at::text AS applied_at FROM schema_migrations ORDER BY version')).rows,earlyAfter);
 assert.match(backup(),/"status":"pass"/);
 report('217 prefix upgraded through every inventory entry; six identity sequences verified, including ALTER-existing-table; low-privilege backup and repeat passed');
 passed=true;
}finally {
 await appDb?.end();await db?.end();await admin?.end();
 if(started) {
  try { docker(['exec',container,'chown','-R',`${process.getuid()}:${process.getgid()}`,scratch]); }
  finally { docker(['rm','-f',container]); }
 }
 if(passed)rmSync(scratch,{recursive:true,force:true});else report(`failed; local evidence retained at ${scratch}`);
}
