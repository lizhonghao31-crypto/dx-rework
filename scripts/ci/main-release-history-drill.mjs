// Two exact Git histories, real original SQL and the unchanged Acceptance maintenance tool.
// This command accepts no database URL; its only DB is a fresh labelled loopback Docker fixture.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,cpSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout} from 'node:timers/promises';
import pg from 'pg';
import {discoverValidatedMigrations} from '../migration-lib.mjs';
import {migrationExecutionSql} from '../deploy/migration-execution-compatibility.mjs';
import {readComparedHistories} from '../check-main-release-compat.mjs';

const repo=resolve(fileURLToPath(new URL('../..',import.meta.url)));
const major=process.argv[2]??'16',proofPath=process.argv[3];
assert.ok(process.argv.length===4&&['13','16'].includes(major),'Usage: main-release-history-drill.mjs [13|16] source-gate-report.json');
const proof=JSON.parse(readFileSync(proofPath,'utf8'));
assert.equal(proof.passed,true);assert.equal(proof.toolSha,proof.candidateSha);assert.ok(proof.baselineSha);
assert.equal(proof.candidateSha,execFileSync('git',['-C',repo,'rev-parse','HEAD'],{encoding:'utf8'}).trim());
const sourceHistories=readComparedHistories(repo,proof);
assert.equal(sourceHistories[1].sha,proof.baselineSha);
assert.equal(sourceHistories[0].rows.length,proof.mainCount);assert.ok(sourceHistories[1].rows.length>0&&sourceHistories[1].rows.length<=proof.candidateCount);
const scratch=mkdtempSync(join(tmpdir(),'dx-main-release-history-'));
const container='dx-main-release-history-'+randomUUID(),password=randomUUID(),owner='dx_rework_acceptance',app='dx_rework_acceptance_app',database='dx_rework_acceptance';
const docker=args=>execFileSync('docker',args,{encoding:'utf8',stdio:['pipe','pipe','pipe'],maxBuffer:20*1024*1024});
const log=message=>process.stdout.write(`MAIN_RELEASE_PG${major} ${message}\n`);
let admin,db,appDb,started=false;
try{
 docker(['run','--rm','-d','--name',container,'--label','dx-rework.test=main-release-history-v1','-e',`POSTGRES_PASSWORD=${password}`,'-p','127.0.0.1::5432','-v',`${repo}:${repo}:ro`,'-v',`${scratch}:${scratch}`,'-v',`${realpathSync(process.execPath)}:/usr/local/bin/node:ro`,major==='13'?'postgres:13.23':'postgres:16-bookworm']);started=true;
 const info=JSON.parse(docker(['inspect',container]))[0];assert.equal(info.Config.Labels['dx-rework.test'],'main-release-history-v1');
 const binding=info.NetworkSettings.Ports['5432/tcp'][0];assert.equal(binding.HostIp,'127.0.0.1');
 let ready=0;for(let i=0;i<60&&ready<3;i++){ready=spawnSync('docker',['exec',container,'pg_isready','-U','postgres','-d','postgres'],{stdio:'ignore'}).status===0?ready+1:0;await setTimeout(1000);}assert.equal(ready,3);
 const url=(role,name)=>`postgresql://${role}:${password}@127.0.0.1:${binding.HostPort}/${name}`;
 admin=new pg.Client({connectionString:url('postgres','postgres')});await admin.connect();
 for(const role of [owner,app])await admin.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
 const catalog=await discoverValidatedMigrations(),byVersion=new Map(catalog.map(r=>[r.version,r]));
 const proxyVersion='0231_temporary_special_process_proxy_reporting',proxy=byVersion.get(proxyVersion);
 assert.equal(proxy?.checksum,'39a9c918c6589c9905ab0cf32de1f7cc304119fd4840a3fa8da34ddfb3e3d6b4');
 const proxyFunctions=()=>db.query("SELECT p.oid::bigint AS oid,p.proname,p.proowner::bigint AS owner,p.proacl::text AS acl FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ('guard_rework_work_report_insert','rework_work_report_actor_authorized') ORDER BY p.proname").then(r=>r.rows);
 const assertProxyGuard=async()=>{
  for(const name of ['guard_rework_work_report_insert','rework_work_report_actor_authorized']){
   const body=proxy.sql.match(new RegExp(`CREATE(?: OR REPLACE)? FUNCTION ${name}\\([\\s\\S]*?AS \\$\\$([\\s\\S]*?)\\$\\$;`))?.[1];assert.ok(body,'Exact original proxy SQL body required');
   const signature=name==='guard_rework_work_report_insert'?`${name}()`:`${name}(uuid,text,uuid)`;
   const row=(await db.query('SELECT prosrc,prosecdef,provolatile FROM pg_proc WHERE oid=$1::regprocedure',[signature])).rows[0];assert.equal(row.prosrc,body);assert.equal(row.prosecdef,false);assert.equal(row.provolatile,name==='guard_rework_work_report_insert'?'v':'s');
  }
  assert.deepEqual((await db.query("SELECT tgfoid='guard_rework_work_report_insert()'::regprocedure AS exact,tgenabled FROM pg_trigger WHERE tgrelid='rework_work_reports'::regclass AND tgname='rework_work_reports_guard_insert'")).rows,[{exact:true,tgenabled:'O'}]);
 };
 const history=client=>client.query('SELECT version,checksum,applied_at::text AS applied_at FROM schema_migrations ORDER BY version').then(r=>r.rows);
 for(const source of sourceHistories){
  await admin.query(`CREATE DATABASE ${database} OWNER ${owner}`);db=new pg.Client({connectionString:url('postgres',database)});await db.connect();await db.query(`SET ROLE ${owner}`);
  await db.query('CREATE TABLE schema_migrations(version text PRIMARY KEY,checksum char(64) NOT NULL,applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)');
  for(const row of source.rows){const migration=byVersion.get(row.version);assert.equal(migration?.checksum,row.checksum);await db.query('BEGIN');await db.query(migrationExecutionSql(migration,Number(major)*10000));await db.query('INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)',[row.version,row.checksum]);await db.query('COMMIT');}
  // Baseline TEST application access is an explicit fixture assumption, never a site ACL export.
  for(const {name} of(await db.query("SELECT relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v')")).rows)await db.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON "${name}" TO ${app}`);
  await db.query(`GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO ${app}`);await db.query('RESET ROLE');
  const before=await history(db),path=join(scratch,source.label);mkdirSync(path);
  log(`${source.label} actual PostgreSQL ${(await db.query('SHOW server_version')).rows[0].server_version}`);
  assert.deepEqual(before.map(({version,checksum})=>({version,checksum})),[...source.rows].sort((a,b)=>a.version.localeCompare(b.version)));
  const identity=(await db.query("SELECT current_database() AS database,current_setting('port')::int AS port,(SELECT oid::bigint FROM pg_database WHERE datname=current_database()) AS oid")).rows[0];identity.oid=Number(identity.oid);identity.address='127.0.0.1';writeFileSync(join(path,'identity.json'),JSON.stringify(identity));
  const generate=(mode,tool=repo)=>{const file=join(path,mode+'-'+(tool===repo?'canonical':'negative')+'.sql');execFileSync('python3',[join(repo,'scripts/deploy/prepare-acceptance-migration.py'),repo,join(path,'identity.json'),'/usr/local/bin/node',join(path,'history.json'),file,mode,tool],{encoding:'utf8',stdio:['ignore','pipe','pipe']});return file;};
  const execute=(file,label,success=true)=>{const r=spawnSync('docker',['exec',container,'psql','-XqAt','-U','postgres','-d',database,'-f',file],{encoding:'utf8',maxBuffer:20*1024*1024});writeFileSync(join(path,label+'.log'),r.stdout+r.stderr);if(success)assert.equal(r.status,0,(r.stderr+r.stdout).slice(-6000));else assert.notEqual(r.status,0,'Expected fail-closed maintenance rejection');return r;};
  if(source.label==='release'){
   const pending=new Set(catalog.filter(row=>!source.rows.some(old=>old.version===row.version)).map(row=>row.version));
   if(pending.has(proxyVersion)){
    await db.query(`ALTER FUNCTION guard_rework_work_report_insert() OWNER TO ${app}`);
    const rejected=execute(generate('preflight'),'proxy-owner',false);assert.match(rejected.stdout,/guard_rework_work_report_insert/);assert.deepEqual(await history(db),before);
    await db.query(`ALTER FUNCTION guard_rework_work_report_insert() OWNER TO ${owner}`);
   }
   if(pending.has('0226_external_revision_preserve_handler')||pending.has('0227_qc_other_craft')){
   await db.query(`ALTER FUNCTION guard_determination_insert() OWNER TO ${app}; ALTER TABLE rework_orders OWNER TO ${app}`);
   const rejected=execute(generate('preflight'),'missing-owner',false);if(pending.has('0226_external_revision_preserve_handler'))assert.match(rejected.stdout,/guard_determination_insert/);if(pending.has('0227_qc_other_craft'))assert.match(rejected.stdout,/rework_orders/);assert.deepEqual(await history(db),before);
   await db.query(`ALTER FUNCTION guard_determination_insert() OWNER TO ${owner}; ALTER TABLE rework_orders OWNER TO ${owner}`);
   }
   const altered=join(path,'altered-tool');cpSync(join(repo,'scripts'),join(altered,'scripts'),{recursive:true});const requirementPath=join(altered,'scripts/deploy/acceptance-migration-requirements.json'),original=JSON.parse(readFileSync(requirementPath,'utf8'));
   for(const [kind,version] of [['missing','0227_qc_other_craft'],['checksum','0226_external_revision_preserve_handler'],['missing',proxyVersion],['checksum',proxyVersion]]){if(!pending.has(version))continue;const changed=structuredClone(original);if(kind==='missing')delete changed[version];else changed[version].checksum='f'.repeat(64);writeFileSync(requirementPath,JSON.stringify(changed));const rejected=execute(generate('preflight',altered),'inventory-'+kind+'-'+version,false);assert.match(rejected.stdout,/CHECKSUM_BOUND_INVENTORY/);assert.deepEqual(await history(db),before);}
  }
  const oldRelations=(await db.query("SELECT relname,relowner,relacl FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','S') ORDER BY relname")).rows;
  const oldFunctions=await proxyFunctions(),sentinel=randomUUID();await db.query("INSERT INTO app_users(id,display_name,enabled) VALUES($1,'TEST retained source history identity',true)",[sentinel]);
  const preflight=execute(generate('preflight'),'valid-preflight');assert.match(preflight.stdout,/acceptance_permissions|permissions_ok|maintenance_role/);assert.deepEqual(await history(db),before);
  const apply=generate('apply');execute(apply,'apply');const after=await history(db);assert.equal(after.length,proof.candidateCount);for(const old of before)assert.deepEqual(after.find(row=>row.version===old.version),old);
  assert.deepEqual(after.map(({version,checksum})=>({version,checksum})),catalog.map(({version,checksum})=>({version,checksum})));
  await assertProxyGuard();const finalFunctions=await proxyFunctions();for(const old of oldFunctions)assert.deepEqual(finalFunctions.find(row=>row.proname===old.proname),old);
  assert.deepEqual((await db.query('SELECT id,display_name,enabled FROM app_users WHERE id=$1',[sentinel])).rows,[{id:sentinel,display_name:'TEST retained source history identity',enabled:true}]);
  execute(apply,'repeat');assert.deepEqual(await history(db),after);
  for(const old of oldRelations)assert.deepEqual((await db.query('SELECT relname,relowner,relacl FROM pg_class WHERE oid=to_regclass($1)',['public.'+old.relname])).rows[0],old);
  const privilege=(await db.query(`SELECT pg_has_role('${app}','${owner}','USAGE') AS app_inherits_maintenance,(SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls FROM pg_roles WHERE rolname='${owner}') AS owner_elevated`)).rows[0];assert.deepEqual(privilege,{app_inherits_maintenance:false,owner_elevated:false});
  appDb=new pg.Client({connectionString:url(app,database)});await appDb.connect();const result=await appDb.query('SELECT external_revision_can_seed_draft($1,$2,$3) AS allowed',[randomUUID(),randomUUID(),randomUUID()]);assert.equal(result.rows[0].allowed,false);assert.equal((await appDb.query("SELECT rework_work_report_actor_authorized($1,'work:report_for_worker',$2) AS allowed",[randomUUID(),randomUUID()])).rows[0].allowed,false);await appDb.end();appDb=null;
  log(`${source.label} ${source.sha} ${before.length}->${after.length}; original identity/checksum/applied_at + existing ACL preserved; actual low-privilege preflight/apply/repeat PASS`);
  await db.end();db=null;await admin.query(`DROP DATABASE ${database}`);
 }
 log('both history paths PASS; no user database URL or production/Acceptance connection accepted');
}finally{
 await appDb?.end().catch(()=>{});await db?.end().catch(()=>{});await admin?.end().catch(()=>{});
 if(started)docker(['rm','-f',container]);rmSync(scratch,{recursive:true,force:true});
}
