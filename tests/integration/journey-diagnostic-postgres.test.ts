import {installAcceptanceClockReader} from '../../apps/api/src/acceptance-clock/business-time.js';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {migrationExecutionSql} from '../../scripts/deploy/migration-execution-compatibility.mjs';
import {DigitalProductionIdentityService} from '../../apps/api/src/production-platform/identity-service.js';
import {DigitalJourneyQuery} from '../../apps/api/src/production-platform/journey-query.js';
import {registerDigitalIdentityRoutes} from '../../apps/api/src/production-platform/identity-routes.js';
import {RootAuthority} from '../../apps/api/src/access/root-authority.js';
import {businessActor} from '../../apps/api/src/access/business-authority.js';
import Fastify from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createJourneyDiagnostic, journeyMeasure } from '../../apps/api/src/platform/journey-diagnostic.js';
import { verifyAcceptanceClockServer } from '../../apps/api/src/acceptance-clock/guard.js';
import { reuseJourneySnapshotReads } from '../../apps/api/src/production-platform/journey-snapshot-reads.js';
import {DIGITAL_RECEIVING_BASE_SQL} from '../../apps/api/src/receiving/receiving-service.js';
import { ownedPostgresSchema, createOwnedPostgresSchema, releaseOwnedPostgresSchema } from '../helpers/owned-postgres-schema.js';

// Use the canonical Acceptance-clock target: the ordinary CI database is deliberately not an Acceptance database.
const url = process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL;
(url ? describe : describe.skip)('Journey diagnostic pg driver compatibility on isolated data', () => {
  const schema = ownedPostgresSchema('business_anchors', 'acceptance-clock');
  const admin = new pg.Pool({ connectionString: url });
  const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 1 });
  const app = Fastify(), lines: string[] = [];
  let created = false;
  const rootId=randomUUID();
  beforeAll(async () => {
    await createOwnedPostgresSchema(admin, schema); created = true;
    const manifest=JSON.parse(await readFile(new URL('../../apps/api/src/platform/migration-manifest.json',import.meta.url),'utf8')) as {migrations:Array<{version:string;checksum:string}>};
    await pool.query('CREATE TABLE schema_migrations(version text PRIMARY KEY,checksum char(64) NOT NULL,applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)');
    const serverVersion=Number((await pool.query('SHOW server_version_num')).rows[0].server_version_num);
    for(const migration of manifest.migrations){const sql=await readFile(new URL(`../../apps/api/migrations/${migration.version}.sql`,import.meta.url),'utf8');await pool.query(migrationExecutionSql({...migration,sql},serverVersion));await pool.query("INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)",[migration.version,migration.checksum]);}
    await pool.query("INSERT INTO app_users(id,display_name,enabled) VALUES($1,'TEST diagnostic',true)",[rootId]);
    await pool.query("INSERT INTO identity_mappings(id,user_id,provider,corp_id,provider_user_id,union_id,active,employed,last_verified_at) VALUES($1,$2,'dingtalk','TEST','uat-root','TEST-diag',true,true,CURRENT_TIMESTAMP)",[randomUUID(),rootId]);
    await pool.query("INSERT INTO user_role_assignments(assignment_id,user_id,role_code,granted_by,grant_reason) VALUES($1,$2,'owner_group',$2,'TEST diagnostic')",[randomUUID(),rootId]);
    await pool.query("INSERT INTO owner_bootstrap_consumptions(singleton,user_id,provider_user_id,corp_id) VALUES(true,$1,'uat-root','TEST')",[rootId]);
    const env = { NODE_ENV: 'test', ACCEPTANCE_LAB_ENABLED: 'true', SERVICE_NAME: 'dx-rework-acceptance-api', HOST: '127.0.0.1', PORT: '3202', DX_REWORK_ROOT: '/opt/dx-rework-acceptance', DINGTALK_CORP_ID: 'TEST', ROOT_DINGTALK_USER_ID: 'uat-root' };
    const proof = await verifyAcceptanceClockServer(pool, url!, env);
    createJourneyDiagnostic(pool, proof, env, { enabled: () => true, emit: line => lines.push(line) })!.register(app);
    app.get('/digital-production/journeys', async () => {
      const value = await journeyMeasure('route_auth', () => pool.query('SELECT 1 AS value'));
      const client = await pool.connect(), reads = reuseJourneySnapshotReads(client);
      try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        await reads.query('SELECT $1::text AS value', ['PRIVATE-ORDER']);
        await reads.query('SELECT $1::text AS value', ['PRIVATE-ORDER']);
        await new Promise<void>((resolve, reject) => client.query({ text: 'SELECT 2' }, error => error ? reject(error) : resolve()));
        await expect(client.query('SELECT 1/0')).rejects.toMatchObject({ code: '22012' });
        await client.query('ROLLBACK');
      } finally { client.release(); }
      await journeyMeasure('clock_postcheck', () => pool.query('SELECT 3'));
      await new Promise<void>((resolve, reject) => pool.query('SELECT 4', error => error ? reject(error) : resolve()));
      return { value: value.rows[0].value };
    });
    await app.ready();
  });
  afterAll(async () => { await app.close(); await pool.end(); if (created) await releaseOwnedPostgresSchema(admin, schema); await admin.end(); });
  it('reuses the original receiving merge-literal CTE without clearing prior facts, and never hides an aborted transaction',async()=>{
    const client=await pool.connect(),original=client.query,seen:string[]=[];
    client.query=function(this:pg.PoolClient,...args:unknown[]){if(typeof args[0]==='string')seen.push(args[0]);return Reflect.apply(original,this,args);} as typeof client.query;
    try{
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const reads=reuseJourneySnapshotReads(client),sql=DIGITAL_RECEIVING_BASE_SQL+' SELECT count(*)::int AS total FROM style_totals',parameters=['2000-01-01','2999-12-31','#',[]];
      expect(sql).toContain("'receiving.batch.merge'");
      expect((await reads.query('SELECT 7 AS value')).rows[0].value).toBe(7);
      const first=await reads.query(sql,parameters);expect(first.rows[0].total).toBe(0);
      expect((await reads.query(sql,parameters)).rows).toEqual(first.rows);
      expect((await reads.query('SELECT 7 AS value')).rows[0].value).toBe(7);
      expect(seen.filter(text=>text===sql)).toHaveLength(1);expect(seen.filter(text=>text==='SELECT 7 AS value')).toHaveLength(1);
      await expect(reads.query('SELECT 1/0')).rejects.toMatchObject({code:'22012'});
      await expect(reads.query('SELECT 7 AS value')).rejects.toMatchObject({code:'25P02'});
    }finally{client.query=original;await client.query('ROLLBACK');client.release();}
  });
  it('counts physical driver calls once across pool/client callbacks, cache hits, rollback and post-release queries', async () => {
    const response = await app.inject('/digital-production/journeys');
    expect(response.statusCode).toBe(200); expect(response.json()).toEqual({ value: 1 });
    expect(lines).toHaveLength(1); expect(lines[0]).not.toMatch(/PRIVATE-ORDER|SELECT|22012/);
    const record = JSON.parse(lines[0]!.slice('JOURNEY_DIAGNOSTIC '.length));
    expect(record.calls.sql).toBe(8); expect(record.cache_hits).toBe(1); expect(record.calls.pool_acquire).toBe(4); expect(record.calls.clock_postcheck).toBe(1);
    expect(pool.waitingCount).toBe(0); expect(pool.idleCount).toBe(1);
    expect((await pool.query('SELECT 5 AS value')).rows[0].value).toBe(5);
    expect(lines).toHaveLength(1);
  });
  it('keeps real queued pool-query SQL attached to the waiting request',async()=>{
    const held=await pool.connect();let released=false;
    const pending=app.inject('/digital-production/journeys').then(response=>response);
    try {
      const deadline=performance.now()+1000;
      while(pool.waitingCount===0&&performance.now()<deadline)await new Promise(resolve=>setTimeout(resolve,1));
      expect(pool.waitingCount).toBe(1);
      held.release();released=true;
      expect((await pending).statusCode).toBe(200);
      const record=JSON.parse(lines[1]!.slice('JOURNEY_DIAGNOSTIC '.length));
      expect(record.calls.sql).toBe(8);expect(record.calls.pool_acquire).toBe(4);expect(record.cache_hits).toBe(1);
      expect(pool.idleCount).toBe(1);expect(pool.waitingCount).toBe(0);
    } finally {if(!released)held.release();await pending;}
  });
  it('preserves a populated real Journey HTTP response with sampling off and on',async()=>{
    const runtimePool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`,max:2});
    const http=Fastify(),samples:string[]=[];let enabled=false;
    const env={NODE_ENV:'test',ACCEPTANCE_LAB_ENABLED:'true',SERVICE_NAME:'dx-rework-acceptance-api',HOST:'127.0.0.1',PORT:'3202',DX_REWORK_ROOT:'/opt/dx-rework-acceptance',DINGTALK_CORP_ID:'TEST',ROOT_DINGTALK_USER_ID:'uat-root'};
    try{
      const proof=await verifyAcceptanceClockServer(runtimePool,url!,env);
      createJourneyDiagnostic(runtimePool,proof,env,{enabled:()=>enabled,emit:line=>samples.push(line)})!.register(http);
      const root=new RootAuthority(runtimePool,'TEST','uat-root'),service=new DigitalProductionIdentityService(runtimePool,true);
      const authenticate=async()=>({id:rootId,displayName:'TEST diagnostic',businessRoles:['owner_group'],capabilities:(await runtimePool.query("SELECT capability FROM role_capabilities WHERE role_code='owner_group'")).rows.map(row=>row.capability as string)});
      const actor=await businessActor(root,await authenticate(),'TEST-diagnostic','pattern_room:orders:create');
      await service.createSource(actor,{developmentType:'头版',designStyleNo:'TEST-DIAGNOSTIC-ONLY',temporaryStyleNo:null,customerCode:null},randomUUID());
      registerDigitalIdentityRoutes(http,{service,journeys:new DigitalJourneyQuery(runtimePool),root,creationEnabled:true,authenticate});
      const off=await http.inject('/digital-production/journeys');expect(off.statusCode).toBe(200);expect(samples).toHaveLength(0);
      enabled=true;
      const on=await http.inject('/digital-production/journeys');expect(on.statusCode).toBe(200);expect(samples).toHaveLength(1);
      const stable=(value:unknown):unknown=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).filter(([key])=>key!=='asOf').map(([key,v])=>[key,stable(v)])):value;
      expect(stable(on.json())).toEqual(stable(off.json()));
      const record=JSON.parse(samples[0]!.slice('JOURNEY_DIAGNOSTIC '.length));
      // Stage counters record one batch boundary, including an empty batch;
      // they do not claim an ordinary read performed a guarded-clock query.
      // The transaction-reader native/unit regressions verify the empty batch
      // makes no clock read, while the scenario below retains its real recheck.
      expect(record.candidates).toBe(1);expect(record.calls.summary_projection).toBe(1);expect(record.calls.detail_projection).toBe(1);expect(record.calls.route_auth).toBe(1);expect(record.calls.clock_postcheck).toBe(1);expect(record.calls.sql).toBeGreaterThan(0);
      const time={now:new Date().toISOString(),scenarioId:randomUUID(),revision:1};
      installAcceptanceClockReader(runtimePool,{read:async(_scope,transaction)=>{await (transaction??runtimePool).query('SELECT 1');return time;},nativeScenario:async()=>null});
      expect((await http.inject('/digital-production/journeys')).statusCode).toBe(200);
      expect(JSON.parse(samples[1]!.slice('JOURNEY_DIAGNOSTIC '.length)).calls.clock_postcheck).toBe(1);
      expect(samples[1]).not.toContain(time.scenarioId);
      expect(samples[0]).not.toContain('TEST-DIAGNOSTIC-ONLY');expect(samples[0]).not.toContain(rootId);
    }finally{await http.close();await runtimePool.end();}
  });

});
