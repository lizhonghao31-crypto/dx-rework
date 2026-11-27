import {execFileSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {describe,it,expect} from 'vitest';
import {discoverValidatedMigrations,applyMigrations} from '../../scripts/migration-lib.mjs';
import {assertTestDatabaseTarget} from '../../scripts/test-database-safety.mjs';
import {ownedPostgresSchema,createOwnedPostgresSchema,dropOwnedPostgresSchema} from '../helpers/owned-postgres-schema.js';

const url=process.env.TEST_DATABASE_URL;
const suite=url?describe:describe.skip;
suite('Acceptance maintenance permissions on isolated PostgreSQL',()=>{
 it('rejects the app-owned table before DDL; the explicitly scoped repair preserves data and permits the owner upgrade',async()=>{
  await assertTestDatabaseTarget(url!);
  const schema=ownedPostgresSchema('acceptance_owner');
  const admin=new pg.Client({connectionString:url});await admin.connect();
  const target=new URL(url!);target.searchParams.set('options',`-c search_path=${schema} -c role=dx_rework_acceptance`);
  const client=new pg.Client({connectionString:target.toString()});
  const catalog=await discoverValidatedMigrations();
  const digital=JSON.parse(await readFile('tests/fixtures/migration-histories/digital-da6590cc.json','utf8')).migrations.slice(0,225) as {version:string;checksum:string}[];
  try{
   await createOwnedPostgresSchema(admin,schema);
   await admin.query(`GRANT USAGE,CREATE ON SCHEMA ${schema} TO dx_rework_acceptance,dx_rework_acceptance_app`);
   await client.connect();
   await client.query('CREATE TABLE schema_migrations(version text PRIMARY KEY,checksum char(64) NOT NULL,applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)');
   for(const row of digital){
    const m=catalog.find(x=>x.version===row.version)!;
    expect(m.checksum).toBe(row.checksum);
    await client.query('BEGIN');await client.query(m.sql);
    await client.query('INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)',[row.version,row.checksum]);await client.query('COMMIT');
   }
   const before=(await client.query('SELECT * FROM schema_migrations ORDER BY version')).rows;
   await admin.query(`ALTER TABLE ${schema}.sourcing_contract_return_submissions OWNER TO dx_rework_acceptance_app`);
   const pending=catalog.filter(x=>!digital.some(r=>r.version===x.version)).map(({version,checksum})=>({version,checksum}));
   const diagnosticQuery=JSON.parse(execFileSync('python3',['-B','-c',`
import importlib.util,json,sys
s=importlib.util.spec_from_file_location('maintenance','scripts/deploy/prepare-acceptance-migration.py')
m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
r=json.load(open('scripts/deploy/acceptance-migration-requirements.json'))
print(json.dumps(m.permission_query(json.loads(sys.argv[1]),r)))
`,JSON.stringify(pending)],{encoding:'utf8',maxBuffer:4*1024*1024})) as string;
   const preflight=async()=>{
    await client.query('BEGIN READ ONLY');
    try {
     const rows=(await client.query(diagnosticQuery.replace(/\bpublic\b/g,schema))).rows;
     const failed=rows.filter(row=>!row.ok);
     if(failed.length)throw Error(JSON.stringify(failed));
    }
    finally{await client.query('ROLLBACK');}
   };
   await expect(preflight()).rejects.toThrow('sourcing_contract_return_submissions');
   expect((await client.query('SELECT * FROM schema_migrations ORDER BY version')).rows).toEqual(before);
   expect((await client.query("SELECT 1 FROM information_schema.columns WHERE table_schema=$1 AND table_name='sourcing_contract_documents' AND column_name='information_revision'",[schema])).rows).toEqual([]);
   // Deliberately explicit, single object only. Never called by the updater.
   await admin.query('BEGIN');
   await admin.query(`ALTER TABLE ${schema}.sourcing_contract_return_submissions OWNER TO dx_rework_acceptance`);
   await admin.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ${schema}.sourcing_contract_return_submissions TO dx_rework_acceptance_app`);
   await admin.query('COMMIT');
   await expect(preflight()).resolves.toBeUndefined();
   for(const table of ['cutting_orders','sourcing_approval_snapshots']){
    await admin.query(`ALTER TABLE ${schema}.${table} OWNER TO dx_rework_acceptance_app`);
    await expect(preflight()).rejects.toThrow(table);
    expect((await client.query('SELECT * FROM schema_migrations ORDER BY version')).rows).toEqual(before);
    await admin.query(`ALTER TABLE ${schema}.${table} OWNER TO dx_rework_acceptance`);
   }
   await expect(preflight()).resolves.toBeUndefined();
   await admin.query(`ALTER FUNCTION ${schema}.guard_cutting_record_creation() OWNER TO dx_rework_acceptance_app`);
   await expect(preflight()).rejects.toThrow('guard_cutting_record_creation');
   await admin.query(`ALTER FUNCTION ${schema}.guard_cutting_record_creation() OWNER TO dx_rework_acceptance`);
   // Under the unchanged earlier history, the view is absent but the
   // checksum-bound 0296 creation precedes its consumers. Once it exists,
   // 0303 must still enforce its real owner before replacing the view.
   expect((await client.query("SELECT to_regclass('digital_development_source_lifecycle') AS view")).rows[0]?.view).toBeNull();
   const firstPublication='0296_development_first_publication';
   for(const next of pending.filter(row=>row.version<=firstPublication)){
    const migration=catalog.find(entry=>entry.version===next.version)!;
    await client.query('BEGIN');await client.query(migration.sql);
    await client.query('INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)',[next.version,next.checksum]);await client.query('COMMIT');
   }
   await expect(preflight()).resolves.toBeUndefined();
   await client.query('ALTER VIEW digital_development_source_lifecycle RENAME TO relocated_lifecycle_fixture');
   await expect(preflight()).rejects.toThrow('digital_development_source_lifecycle');
   await client.query('ALTER VIEW relocated_lifecycle_fixture RENAME TO digital_development_source_lifecycle');
   await admin.query(`ALTER VIEW ${schema}.digital_development_source_lifecycle OWNER TO dx_rework_acceptance_app`);
   await expect(preflight()).rejects.toThrow('digital_development_source_lifecycle');
   await admin.query(`ALTER VIEW ${schema}.digital_development_source_lifecycle OWNER TO dx_rework_acceptance`);
   await expect(preflight()).resolves.toBeUndefined();
   // Designer corrections replace the existing effective documents view, not a new view.
   const beforeDesignerCorrection='0317_development_draft_discard_ownership';
   for(const next of pending.filter(row=>row.version>firstPublication&&row.version<=beforeDesignerCorrection)){
    const migration=catalog.find(entry=>entry.version===next.version)!;
    await client.query('BEGIN');await client.query(migration.sql);
    await client.query('INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)',[next.version,next.checksum]);await client.query('COMMIT');
   }
   await expect(preflight()).resolves.toBeUndefined();
   await admin.query(`ALTER VIEW ${schema}.digital_development_effective_documents OWNER TO dx_rework_acceptance_app`);
   await expect(preflight()).rejects.toThrow('digital_development_effective_documents');
   await admin.query(`ALTER VIEW ${schema}.digital_development_effective_documents OWNER TO dx_rework_acceptance`);
   await expect(preflight()).resolves.toBeUndefined();
   const upgraded=await applyMigrations(target.toString());
   expect(upgraded.currentVersion).toBe(catalog.at(-1)!.version);
   expect((await applyMigrations(target.toString())).applied).toEqual([]);
   const after=(await client.query('SELECT * FROM schema_migrations ORDER BY version')).rows;
   expect(after).toHaveLength(catalog.length);
   for(const row of before)expect(after.find(x=>x.version===row.version)).toEqual(row);
   expect((await client.query("SELECT has_table_privilege('dx_rework_acceptance_app','sourcing_contract_return_submissions','INSERT') AS allowed")).rows[0].allowed).toBe(true);
  }finally{await client.end();await dropOwnedPostgresSchema(admin,schema);await admin.end();}
 },120000);
});
