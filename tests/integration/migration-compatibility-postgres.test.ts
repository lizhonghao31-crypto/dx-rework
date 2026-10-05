import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import pg from 'pg';
import {describe,it,expect} from 'vitest';
import {applyMigrations,discoverValidatedMigrations} from '../../scripts/migration-lib.mjs';
import {assertTestDatabaseTarget} from '../../scripts/test-database-safety.mjs';
import {ownedPostgresSchema} from '../helpers/owned-postgres-schema.js';

type Entry={version:string;checksum:string};
const url=process.env.TEST_DATABASE_URL;
const suite=url?describe:describe.skip;
suite('main and digital historical PostgreSQL upgrades',()=>{
 it.each(['main','main-219-derived','acceptance-prefix','a3','empty','interrupted-main','main-221','main-222','acceptance-236','integrated-237'] as const)('upgrades %s preserving identities, checksums, timestamps and business rows',async lane=>{
  await assertTestDatabaseTarget(url!);
  const catalog=await discoverValidatedMigrations();
  const main:Entry[]=JSON.parse(await readFile('tests/fixtures/migration-histories/main-99db5239.json','utf8')).migrations;
  const digital:Entry[]=JSON.parse(await readFile('tests/fixtures/migration-histories/digital-da6590cc.json','utf8')).migrations;
  const main221:Entry[]=JSON.parse(await readFile('tests/fixtures/migration-histories/main-9fcc05c4.json','utf8')).migrations;
  const main222:Entry[]=JSON.parse(await readFile('tests/fixtures/migration-histories/main-ab028c31.json','utf8')).migrations;
  const acceptance236:Entry[]=JSON.parse(await readFile('tests/fixtures/migration-histories/release-e9d687a3.json','utf8')).migrations;
  const history=lane==='main-222'?main222:lane==='main-221'?main221:lane==='acceptance-236'?acceptance236:lane==='integrated-237'?catalog:lane==='main-219-derived'?main.slice(0,219):lane==='main'||lane==='interrupted-main'?main:lane==='a3'?digital:lane==='acceptance-prefix'?digital.slice(0,225):[];
  const schema=ownedPostgresSchema('migration_compat');
  const admin=new pg.Client({connectionString:url});await admin.connect();
  const scoped=new URL(url!);scoped.searchParams.set('options',`-c search_path=${schema}`);
  const client=new pg.Client({connectionString:scoped.toString()});
  try{
   await admin.query(`CREATE SCHEMA ${schema}`);await client.connect();
   await client.query('CREATE TABLE schema_migrations(version text PRIMARY KEY,checksum char(64) NOT NULL,applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)');
   for(const entry of history){
    const migration=catalog.find(m=>m.version===entry.version);expect(migration?.checksum).toBe(entry.checksum);
    await client.query('BEGIN');await client.query(migration!.sql);
    await client.query('INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)',[entry.version,entry.checksum]);await client.query('COMMIT');
   }
   const before=(await client.query('SELECT version,checksum,applied_at FROM schema_migrations ORDER BY version')).rows;
   if(['main-221','acceptance-236','integrated-237'].includes(lane)){
    // Execute the exact [1/5] read-only fragment selected by the installed
    // 209b008 worker, with its immutable policy files. No root wrapper, PM2,
    // backup, production connection or update phase is invoked here.
    const scratch=await mkdtemp(join(tmpdir(),'dx-main221-preflight-'));
    try{
     const old='209b00854c217c9fd2e5a6bbc0f5096c0016df0a';
     await mkdir(join(scratch,'scripts/deploy'),{recursive:true});
     for(const path of ['scripts/migration-history-policy.mjs','scripts/migration-branches.json','scripts/deploy/acceptance-update-policy.mjs'])
      await writeFile(join(scratch,path),execFileSync('git',['show',`${old}:${path}`]));
     const worker=execFileSync('git',['show',`${old}:scripts/deploy/update-acceptance-local.sh`],{encoding:'utf8'});
     const fragment=worker.slice(worker.indexOf("echo '[1/5]"),worker.indexOf("echo '[2/5]"));
     expect(fragment).toContain('node_exec "$policy" "$source_dir/production-history.json" "$manifest" production');
     const exported={database:'dx_rework_production',migrations:before.map(r=>({version:r.version,checksum:r.checksum}))};
     await writeFile(join(scratch,'production-history.json'),JSON.stringify(exported));
     const entry=(policy:string,manifest:string)=>execFileSync('bash',['-c','set -euo pipefail; policy="$1"; source_dir="$2"; manifest="$3"; node_bin="$4"; node_exec(){ "$node_bin" "$@"; }; '+fragment,'preflight',policy,scratch,manifest,process.execPath],{encoding:'utf8',stdio:['pipe','pipe','pipe']});
     // Old tool cannot approve the new 0221 pair even if the candidate is fixed.
     expect(()=>entry(join(scratch,'scripts/deploy/acceptance-update-policy.mjs'),join(process.cwd(),'apps/api/src/platform/migration-manifest.json'))).toThrow('sequence gap');
     if(lane==='main-221'){
      expect(()=>entry(join(scratch,'scripts/deploy/acceptance-update-policy.mjs'),join(process.cwd(),'tests/fixtures/migration-histories/release-e9d687a3.json'))).toThrow('absent from Head manifest: 0221_sourcing_factory_change_crafts');
     }
     expect(JSON.parse(entry(join(process.cwd(),'scripts/deploy/acceptance-update-policy.mjs'),join(process.cwd(),'apps/api/src/platform/migration-manifest.json')).trim().split('\n').at(-1)!)).toMatchObject({status:'compatible',applied:history.length});
     expect((await client.query('SELECT version,checksum,applied_at FROM schema_migrations ORDER BY version')).rows).toEqual(before);
    }finally{await rm(scratch,{recursive:true,force:true});}
   }
   const sentinel=randomUUID();
   if(history.length)await client.query("INSERT INTO app_users(id,display_name,enabled) VALUES($1,'TEST migration retained business identity',true)",[sentinel]);
   const env={...process.env,DATABASE_URL:scoped.toString()};
   const run=(command:string)=>JSON.parse(execFileSync(process.execPath,['scripts/deploy/database-state.mjs',command,'apps/api/src/platform/migration-manifest.json'],{env,encoding:'utf8'}));
   expect(run('verify-prefix').status).toBe('pass');
   expect(run('export-history').migrations).toEqual(before.map(r=>({version:r.version,checksum:r.checksum})));
   if(lane==='interrupted-main'){
    // Stop the genuine migrator after one new transaction commits, then resume.
    await client.query("CREATE FUNCTION test_stop_migration() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.version='0219_digital_production_access' THEN RAISE EXCEPTION 'TEST planned interruption'; END IF; RETURN NEW; END $$");
    await client.query('CREATE TRIGGER test_stop BEFORE INSERT ON schema_migrations FOR EACH ROW EXECUTE FUNCTION test_stop_migration()');
    await expect(applyMigrations(scoped.toString())).rejects.toThrow('TEST planned interruption');
    expect((await client.query("SELECT count(*)::int n FROM schema_migrations WHERE version='0218_digital_production_identity'")).rows[0].n).toBe(1);
    await client.query('DROP TRIGGER test_stop ON schema_migrations');
   }
   const result=await applyMigrations(scoped.toString());expect(result.currentVersion).toBe('0233_manual_contract_template_provenance');
   expect((await applyMigrations(scoped.toString())).applied).toEqual([]);
   const after=(await client.query('SELECT version,checksum,applied_at FROM schema_migrations ORDER BY version')).rows;
   expect(after.map(r=>({version:r.version,checksum:r.checksum}))).toEqual(catalog.map(({version,checksum})=>({version,checksum})));
   for(const row of before)expect(after.find(r=>r.version===row.version)).toEqual(row);
   if(history.length)expect((await client.query('SELECT display_name FROM app_users WHERE id=$1',[sentinel])).rows[0].display_name).toBe('TEST migration retained business identity');
   expect((await client.query("SELECT count(*)::int n FROM sourcing_contract_template_versions WHERE template_version=4")).rows[0].n).toBe(1);
   expect(run('verify-current').count).toBe(catalog.length);
   expect(JSON.parse(execFileSync(process.execPath,['scripts/deploy/verify-database-readiness.mjs','apps/api/src/platform/migration-manifest.json'],{env,encoding:'utf8'})).status).toBe('ready');
   // Drift and unknown rows must stop before any further migration can run.
   await client.query('UPDATE schema_migrations SET checksum=$1 WHERE version=$2',['0'.repeat(64),catalog[0]!.version]);
   await expect(applyMigrations(scoped.toString())).rejects.toThrow('checksum drift');
   await client.query('UPDATE schema_migrations SET checksum=$1 WHERE version=$2',[catalog[0]!.checksum,catalog[0]!.version]);
   await client.query("INSERT INTO schema_migrations(version,checksum) VALUES('9999_unknown_test',$1)",['f'.repeat(64)]);
   await expect(applyMigrations(scoped.toString())).rejects.toThrow('absent from Head');
  }finally{await client.end();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();}
 },120000);
});
