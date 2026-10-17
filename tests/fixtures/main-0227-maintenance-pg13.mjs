// Disposable, marked PG13 database only. ACL changes below are test setup,
// never release operations. Controller runtime probes are local stubs; SQL is real.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { applyMigrations } from '../../scripts/migration-lib.mjs';
import { assertTestDatabaseTarget } from '../../scripts/test-database-safety.mjs';

await assertTestDatabaseTarget();
const url=new URL(process.env.TEST_DATABASE_URL), adminUrl=new URL(process.env.TEST_ADMIN_DATABASE_URL);
assert(['127.0.0.1','localhost'].includes(url.hostname));
assert.equal(adminUrl.hostname,url.hostname); assert.equal(adminUrl.port,url.port); assert.equal(adminUrl.pathname,url.pathname);
const db=new pg.Client({connectionString:url.toString()}), admin=new pg.Client({connectionString:adminUrl.toString()});
await db.connect(); await admin.connect();
const server=(await db.query('select version() AS server_version')).rows[0].server_version;
assert.match(server,/PostgreSQL 13\./);
assert.equal((await db.query("select to_regclass('public.schema_migrations') existing")).rows[0].existing,null,'fresh disposable database required');
const root=process.cwd(), scratch=mkdtempSync(join(tmpdir(),'main-maint-pg13-'));
const version='0227_qc_other_craft', checksum='2b4ee5e688926de2d9195e762140fe80ef6dba2ccdaa0cae6575c321426b0748';
const oldSha='c'.repeat(40), newSha='d'.repeat(40);
const source=join(scratch,'prefix'), tool=join(scratch,'tools',newSha), state=join(scratch,'state'), runtime=join(scratch,'runtime'), bin=join(scratch,'bin');
const write=(p,s)=>{mkdirSync(join(p,'..'),{recursive:true});writeFileSync(p,s);};
const executable=(name,body)=>writeFileSync(join(bin,name),body,{mode:0o755});
const plans=JSON.parse(readFileSync('scripts/deploy/main-maintenance-plans.json','utf8'));
const manifest=JSON.parse(readFileSync('apps/api/src/platform/migration-manifest.json','utf8'));
const prefix={migrations:manifest.migrations.filter(m=>m.version<version)};
write(join(source,'apps/api/src/platform/migration-manifest.json'),JSON.stringify(prefix));
mkdirSync(join(source,'apps/api/migrations'),{recursive:true});
for(const row of prefix.migrations) cpSync(`apps/api/migrations/${row.version}.sql`,join(source,`apps/api/migrations/${row.version}.sql`));
for(const name of ['deploy/check-main-maintenance-plan.mjs','migration-history-policy.mjs','migration-branches.json','migration-main-extensions.json']) {
  mkdirSync(join(tool,'scripts',name,'..'),{recursive:true}); cpSync(join(root,'scripts',name),join(tool,'scripts',name));
}
symlinkSync(join(root,'node_modules'),join(tool,'node_modules'));
const planFile=join(tool,'scripts/deploy/main-maintenance-plans.json'); write(planFile,JSON.stringify(plans));
const env={...process.env,DATABASE_URL:url.toString(),NODE_ENV:'test'};
const run=(script,args=[],extra={})=>spawnSync(process.execPath,[script,...args],{encoding:'utf8',env:{...env,...extra}});
const checked=(result)=>{assert.equal(result.status,0,result.stderr||result.stdout);return result.stdout;};
const history=async()=> (await db.query('select version,btrim(checksum) checksum,applied_at from schema_migrations order by version')).rows;
const guard=async()=> (await db.query("select pg_get_functiondef('public.guard_rework_order_write()'::regprocedure) definition")).rows[0].definition;
const user=(await db.query('select current_user AS role_name')).rows[0].role_name;
const quote=s=>'"'+s.replaceAll('"','""')+'"';
const checks=[];
try {
  process.env.DX_REWORK_MIGRATIONS_DIR=join(source,'apps/api/migrations');
  process.env.DX_REWORK_MIGRATION_MANIFEST=join(source,'apps/api/src/platform/migration-manifest.json');
  const seeded=await applyMigrations(url.toString()); assert.equal(seeded.applied.length,prefix.migrations.length);
  delete process.env.DX_REWORK_MIGRATIONS_DIR; delete process.env.DX_REWORK_MIGRATION_MANIFEST;
  const before=await history(), beforeGuard=await guard();
  checked(run(join(tool,'scripts/deploy/check-main-maintenance-plan.mjs'),[root]));
  checks.push('restricted-role exact 0227 admission');

  for(const p of [state,bin,join(runtime,'locks'),join(scratch,'etc/nginx'),join(runtime,'frontend/releases',newSha)])mkdirSync(p,{recursive:true});
  chmodSync(state,0o700);
  write(join(runtime,'locks/release.lock'),'');
  write(join(state,'node-binary'),join(bin,'node22')); write(join(state,'nginx-config'),join(scratch,'etc/nginx/main.conf'));
  write(join(state,'active.json'),JSON.stringify({sha:oldSha,port:3203})); write(join(state,'previous-active.json'),JSON.stringify({sha:oldSha,port:3203}));
  write(join(state,'previous-active-nginx.conf'),'fixture nginx'); write(join(state,'nginx-template.conf'),'fixture nginx');
  write(join(scratch,'etc/nginx/main.conf'),'fixture nginx'); write(join(state,'candidate-sha'),newSha); write(join(state,'candidate-port'),'3203');
  write(join(state,'served-sha'),oldSha); write(join(state,'calls.jsonl'),'');
  const worker=join(scratch,'worker.mjs');
  write(worker,`
    import {basename} from 'node:path';import {appendFileSync,writeFileSync} from 'node:fs';import {spawnSync} from 'node:child_process';
    import {applyMigrations} from ${JSON.stringify(join(root,'scripts/migration-lib.mjs'))};
    const [script,...args]=process.argv.slice(2), name=basename(script), state=${JSON.stringify(state)};
    appendFileSync(state+'/calls.jsonl',JSON.stringify({name,args})+'\\n');
    if(name==='prepare-online-candidate.sh') {
      const p=spawnSync(process.execPath,[${JSON.stringify(join(tool,'scripts/deploy/check-main-maintenance-plan.mjs'))},process.env.FIXTURE_SOURCE],{env:process.env,encoding:'utf8'});
      process.stdout.write(p.stdout);process.stderr.write(p.stderr);if(p.status===0)writeFileSync(args[0]+'/CANDIDATE_SHA',args[1]==='recovery'?args[2]:${JSON.stringify(newSha)});process.exit(p.status ?? 1);
    }
    if(name==='apply-main-maintenance.sh') {
      if(args[0]==='apply') await applyMigrations(process.env.DATABASE_URL);
      else {const p=spawnSync(process.execPath,[${JSON.stringify(join(root,'scripts/deploy/database-state.mjs'))},'verify-current',args[1]===${JSON.stringify(oldSha)}?${JSON.stringify(join(source,'apps/api/src/platform/migration-manifest.json'))}:${JSON.stringify(join(root,'apps/api/src/platform/migration-manifest.json'))}],{env:process.env,encoding:'utf8'});process.stdout.write(p.stdout);process.stderr.write(p.stderr);process.exit(p.status);}
    }
    if(name==='start-online-slot.sh'&&args[0]==='start') writeFileSync(state+'/served-sha',args[1]);
  `);
  executable('id','#!/bin/sh\necho 0\n'); executable('chown','#!/bin/sh\nexit 0\n'); executable('sleep','#!/bin/sh\nexit 0\n');
  executable('stat','#!/bin/sh\nif [ "$2" = "%U" ]; then echo root; else exec /usr/bin/stat "$@"; fi\n');
  executable('runuser',`#!${process.execPath}\nimport {spawnSync} from 'node:child_process';const a=process.argv.slice(2),i=a.indexOf('bash');const p=spawnSync(${JSON.stringify(process.execPath)},[${JSON.stringify(worker)},...a.slice(i+1)],{env:process.env,stdio:'inherit'});process.exit(p.status);\n`);
  executable('curl',`#!${process.execPath}\nimport {readFileSync,existsSync} from 'node:fs';const s=${JSON.stringify(state)},a=process.argv.slice(2),sha=readFileSync(s+'/served-sha','utf8');if(a.at(-1).endsWith('/version'))console.log(JSON.stringify({gitSha:sha}));else if(existsSync(s+'/fail-start')&&sha===${JSON.stringify(newSha)})process.exit(1);else console.log('X-Dx-Release-Protocol: 2');\n`);
  executable('python3','#!/bin/sh\nexit 0\n');
  executable('nginx',`#!/bin/sh\necho nginx >> '${state}/traffic.log'\nexit 0\n`);
  executable('node',`#!${process.execPath}\nimport {writeFileSync} from 'node:fs';import {spawnSync} from 'node:child_process';const a=process.argv.slice(2);if(a[0].endsWith('/render-online-nginx.mjs'))writeFileSync(a[2],'fixture rendered nginx');else{const p=spawnSync(${JSON.stringify(process.execPath)},a,{env:process.env,stdio:'inherit'});process.exit(p.status);}\n`);
  executable('node22',`#!/bin/sh\nexec '${process.execPath}' "$@"\n`);
  write(join(tool,'scripts/deploy/lib.sh'),'DX_ROOT="$DX_REWORK_ROOT"\ndie(){ echo "$*" >&2; exit 1; }; require_sha(){ [[ "$1" =~ ^[0-9a-f]{40}$ ]]; }; assert_root_node(){ :; }; safe_log(){ echo "$*"; }\n');
  const controller=join(tool,'scripts/deploy/update-main-maintenance.sh');
  write(controller,readFileSync('scripts/deploy/update-main-maintenance.sh','utf8').replaceAll('/opt/dx-rework-release-tools',join(scratch,'tools')).replaceAll('/opt/dx-rework-release-state',state).replaceAll('/opt/dx-rework',runtime).replaceAll('/etc/nginx/',join(scratch,'etc/nginx')+'/'));
  const control=(phase,extra={})=>{write(join(state,'phase'),phase);return spawnSync('bash',[controller],{env:{...env,PATH:bin+':'+process.env.PATH,FIXTURE_SOURCE:root,...extra},encoding:'utf8'});};
  const untouched=async(result,message)=>{
    assert.notEqual(result.status,0);assert.match(result.stderr,new RegExp(message));
    assert.deepEqual(await history(),before);assert.equal(await guard(),beforeGuard);
    assert.equal(readFileSync(join(state,'phase'),'utf8').trim(),'completed');
    assert.equal(readFileSync(join(scratch,'etc/nginx/main.conf'),'utf8'),'fixture nginx');
    assert(!existsSync(join(state,'traffic.log')),'no nginx transition before failed admission');
  };
  write(planFile,JSON.stringify(plans.filter(p=>p.version!==version)));
  await untouched(control('completed'),'MIGRATION_PLAN_REQUIRED'); checks.push('old installed plan rejects before routing/stop');
  write(planFile,JSON.stringify(plans));
  const drift=join(scratch,'drift');cpSync(join(root,'apps/api/src/platform'),join(drift,'apps/api/src/platform'),{recursive:true});
  write(join(drift,`apps/api/migrations/${version}.sql`),readFileSync(`apps/api/migrations/${version}.sql`,'utf8')+'\n');
  await untouched(control('completed',{FIXTURE_SOURCE:drift}),'fingerprint drift');checks.push('SQL drift rejects before routing/stop');
  const adminUser=(await admin.query('select current_user AS role_name')).rows[0].role_name;
  for(const table of ['public.rework_orders','public.rework_process_configuration_items']) {
    await admin.query(`ALTER TABLE ${table} OWNER TO ${quote(adminUser)}`);
    await untouched(control('completed'),table.replaceAll('.','\\.'));
    await admin.query(`ALTER TABLE ${table} OWNER TO ${quote(user)}`);
    await admin.query(`REVOKE TRIGGER ON ${table} FROM PUBLIC,${quote(user)}`);
    assert.equal((await db.query("SELECT has_table_privilege(current_user,$1,'TRIGGER') allowed",[table])).rows[0].allowed,false);
    await assert.rejects(db.query(`CREATE CONSTRAINT TRIGGER pg13_trigger_privilege_probe AFTER INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION public.guard_rework_order_write()`),{code:'42501'});
    await untouched(control('completed'),`table ${table.replaceAll('.','\\.')} TRIGGER`);
    await admin.query(`GRANT TRIGGER ON ${table} TO ${quote(user)}`);
    checks.push(`${table} ownership and TRIGGER refusal before routing/stop`);
  }
  await admin.query(`ALTER FUNCTION public.guard_rework_order_write() OWNER TO ${quote(adminUser)}`);
  await untouched(control('completed'),'function public.guard_rework_order_write');
  await admin.query(`ALTER FUNCTION public.guard_rework_order_write() OWNER TO ${quote(user)}`);checks.push('function owner refusal before routing/stop');
  await admin.query(`REVOKE CREATE ON SCHEMA public FROM PUBLIC,${quote(user)}`);
  await untouched(control('completed'),'schema public');
  await admin.query(`GRANT CREATE ON SCHEMA public TO ${quote(user)}`);checks.push('schema CREATE refusal before routing/stop');
  await admin.query(`REVOKE USAGE ON LANGUAGE plpgsql FROM PUBLIC,${quote(user)}`);
  await untouched(control('completed'),'language plpgsql');
  await admin.query(`GRANT USAGE ON LANGUAGE plpgsql TO ${quote(user)}`);checks.push('plpgsql USAGE refusal before routing/stop');
  assert(!readFileSync(join(state,'calls.jsonl'),'utf8').includes('start-online-slot.sh'));

  await admin.query('CREATE FUNCTION public.guard_rework_special_process() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW; END$$');
  const failed=control('maintenance-migrating');assert.notEqual(failed.status,0,failed.stdout);
  assert.deepEqual(await history(),before);assert.equal(await guard(),beforeGuard);
  assert.equal(readFileSync(join(state,'phase'),'utf8').trim(),'maintenance-reverted');checks.push('real transactional DDL failure restores old only with unchanged entire history');
  await admin.query('DROP FUNCTION public.guard_rework_special_process()');
  write(join(state,'calls.jsonl'),'');write(join(state,'fail-start'),'1');
  const committed=control('maintenance-migrating');assert.notEqual(committed.status,0,committed.stderr);
  const after=await history();assert.deepEqual(after.slice(0,-1),before);assert.equal(after.at(-1).version,version);assert.equal(after.at(-1).checksum,checksum);
  assert.equal(readFileSync(join(state,'phase'),'utf8').trim(),'maintenance-migrated');
  assert(!readFileSync(join(state,'calls.jsonl'),'utf8').includes(JSON.stringify({name:'start-online-slot.sh',args:['start',oldSha,'3203']})));
  checks.push('committed 0227 plus startup failure retains maintenance without old restart');
  rmSync(join(state,'fail-start'));write(join(state,'calls.jsonl'),'');
  checked(control('maintenance-migrated'));
  assert.equal(JSON.parse(readFileSync(join(state,'active.json'),'utf8')).sha,newSha);
  assert.equal(readFileSync(join(state,'candidate-sha'),'utf8'),newSha);
  assert(!readFileSync(join(state,'calls.jsonl'),'utf8').includes('prepare-online-candidate.sh'));
  assert.deepEqual(await history(),after);assert.equal((await applyMigrations(url.toString())).applied.length,0);
  checks.push('retry uses same frozen candidate without fetch/reapply; second migration application zero');
  write(join(state,'calls.jsonl'),'');
  const repeated=control('completed');checked(repeated);assert.match(repeated.stdout,/already current/);
  const repeatCalls=readFileSync(join(state,'calls.jsonl'),'utf8');assert(!repeatCalls.includes('stop-main-runtime.sh'));assert(!repeatCalls.includes('apply-main-maintenance.sh'));assert.deepEqual(await history(),after);
  checks.push('already-target completed entry returns success without stop or migration');
  console.log(JSON.stringify({postgres:server,role:user,preservedMigrationReceipts:before.length,migration:{version,checksum},controller:'actual Bash controller; stub runtime probes; real restricted-role SQL',checks},null,2));
} finally {
  delete process.env.DX_REWORK_MIGRATIONS_DIR;delete process.env.DX_REWORK_MIGRATION_MANIFEST;
  await db.end();await admin.end();rmSync(scratch,{recursive:true,force:true});
}
