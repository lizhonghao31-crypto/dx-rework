import * as fs from 'node:fs';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import { chmodSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { createDiagnosticSink, createJourneyDiagnostic, diagnosticWindow, journeyMeasure, readDiagnosticLease, readDiagnosticWindow } from '../../apps/api/src/platform/journey-diagnostic.js';
import { verifyAcceptanceClockServer, type AcceptanceServerProof } from '../../apps/api/src/acceptance-clock/guard.js';
import { reuseJourneySnapshotReads } from '../../apps/api/src/production-platform/journey-snapshot-reads.js';

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof fs>();
  return {...actual, readSync:vi.fn(actual.readSync), closeSync:vi.fn(actual.closeSync), write:vi.fn(actual.write)};
});

const env = { NODE_ENV: 'test', ACCEPTANCE_LAB_ENABLED: 'true', SERVICE_NAME: 'dx-rework-acceptance-api', HOST: '127.0.0.1', PORT: '3202', DX_REWORK_ROOT: '/opt/dx-rework-acceptance', DINGTALK_CORP_ID: 'TEST', ROOT_DINGTALK_USER_ID: 'uat-root' };
const result = { rows: [{ ok: true }], fields: [], command: 'SELECT', rowCount: 1, oid: 0 };
async function fixture(enabled = () => true, emit?: (line: string) => void, window?: () => ReturnType<typeof readDiagnosticLease>) {
  let driverCalls = 0;
  const client = { query(...args: unknown[]) { driverCalls++; const cb = args.at(-1); if (typeof cb === 'function') { cb(null, result); return undefined; } return Promise.resolve(result); }, release() {} } as unknown as PoolClient;
  const pool = { query: async (sql: string) => ({ rows: sql === 'SELECT current_database()' ? [{ current_database: 'dx_rework_acceptance' }] : [{ provider_user_id: 'uat-root', corp_id: 'TEST', identity_matches: true, has_owner_role: true }] }), connect(callback?: (error: null, client: PoolClient, release: () => void) => void) { if (callback) { callback(null, client, () => {}); return; } return Promise.resolve(client); } } as unknown as Pool;
  const proof = await verifyAcceptanceClockServer(pool, 'postgres://test@localhost/dx_rework_acceptance', env);
  const lines: string[] = [], app = Fastify();
  const diagnostic = createJourneyDiagnostic(pool, proof, env, { enabled, ...(window ? {window} : {}), emit: emit ?? (line => lines.push(line)) })!;
  diagnostic.register(app);
  app.get('/digital-production/journeys', async () => journeyMeasure('route_auth', async () => {
    const db = await pool.connect(), cached = reuseJourneySnapshotReads(db);
    await cached.query('SELECT secret FROM orders WHERE id=$1', ['PRIVATE-ID']);
    await cached.query('SELECT secret FROM orders WHERE id=$1', ['PRIVATE-ID']);
    await new Promise<void>((resolve, reject) => pool.connect((error, other, release) => { if (error) { reject(error); return; } other.query('SELECT callback', err => { release(); if (err) reject(err); else resolve(); }); }));
    db.release(); return { ok: true };
  }));
  app.get('/digital-production/journeys/:id', async () => ({ ok: true }));
  return { app, pool, proof, lines, driverCalls: () => driverCalls, record: () => JSON.parse(lines[0]!.slice('JOURNEY_DIAGNOSTIC '.length)) };
}

describe('Acceptance journey diagnostics', () => {
  it('rejects absent, malformed, stale, future and overlong windows', () => {
    const now = Date.now(), startedAt = new Date(now - 1_000).toISOString(), expiresAt = new Date(now + 60_000).toISOString();
    expect(diagnosticWindow({ enabled: true, startedAt, expiresAt }, now)).toBe(true);
    for (const config of [undefined, {}, { enabled: false, startedAt, expiresAt }, { enabled: true, startedAt, expiresAt, url: 'secret' }, { enabled: true, startedAt: expiresAt, expiresAt }, { enabled: true, startedAt, expiresAt: startedAt }, { enabled: true, startedAt, expiresAt: new Date(now + 900_000).toISOString() }]) expect(diagnosticWindow(config, now)).toBe(false);
  });
  it('reads only small private regular files owned by the runtime and closes on errors', () => {
    const dir = mkdtempSync(join(tmpdir(), 'journey-diag-')), file = join(dir, 'window.json');
    try {
      expect(readDiagnosticWindow(file)).toBe(false);
      writeFileSync(file, JSON.stringify({ enabled: true, startedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() }), { mode: 0o600 });
      expect(readDiagnosticWindow(file)).toBe(true);
      symlinkSync(file, join(dir, 'link')); expect(readDiagnosticWindow(join(dir, 'link'))).toBe(false);
      chmodSync(file, 0o644); expect(readDiagnosticWindow(file)).toBe(false);
      chmodSync(file, 0o600); writeFileSync(file, 'x'.repeat(513)); expect(readDiagnosticWindow(file)).toBe(false);
      writeFileSync(file, '{'); expect(readDiagnosticWindow(file)).toBe(false);
    } finally { rmSync(dir, { recursive: true }); }
  });
  it('bounds a file-growth race to 513 bytes and isolates descriptor cleanup errors', async () => {
    const actual = await vi.importActual<typeof fs>('node:fs');
    const dir=mkdtempSync(join(tmpdir(),'journey-race-')),file=join(dir,'window.json');
    const content=JSON.stringify({enabled:true,startedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60_000).toISOString()});
    try {
      writeFileSync(file,content,{mode:0o600});
      vi.mocked(fs.readSync).mockImplementationOnce(((...args:unknown[])=>{
        writeFileSync(file,content+' '.repeat(2000));
        expect(args[3]).toBe(513);
        return Reflect.apply(actual.readSync,actual,args);
      }) as typeof fs.readSync);
      expect(readDiagnosticWindow(file)).toBe(false);
      writeFileSync(file,content);
      vi.mocked(fs.closeSync).mockImplementationOnce(fd=>{actual.closeSync(fd);throw new Error('TEST cleanup failure');});
      expect(()=>readDiagnosticWindow(file)).not.toThrow();
    } finally {rmSync(dir,{recursive:true});}
  });
  it('binds in-flight output to the original inode even when the replacement has identical content', async()=>{
    const dir=mkdtempSync(join(tmpdir(),'journey-window-')),file=join(dir,'window.json');
    const content=JSON.stringify({enabled:true,startedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60_000).toISOString()});
    writeFileSync(file,content,{mode:0o600});
    const f=await fixture(()=>true,undefined,()=>readDiagnosticLease(file));
    const original=readDiagnosticLease(file)!;
    f.app.addHook('onSend',async()=>{
      const replacement=join(dir,'replacement');writeFileSync(replacement,content,{mode:0o600});renameSync(replacement,file);
    });
    try {
      expect((await f.app.inject('/digital-production/journeys')).statusCode).toBe(200);
      expect(readDiagnosticLease(file)!.key).not.toBe(original.key);
      expect(f.lines).toHaveLength(0);
    } finally {await f.app.close();rmSync(dir,{recursive:true});}
  });
  it('drops output on monotonic expiry even if wall time rolls backward',async()=>{
    const f=await fixture(()=>true,undefined,()=>({key:'fixed-window',expiresAt:Date.now()+60_000}));
    const realNow=performance.now.bind(performance);
    f.app.addHook('onSend',async()=>{vi.spyOn(performance,'now').mockImplementation(()=>realNow()+900_001);});
    try {expect((await f.app.inject('/digital-production/journeys')).statusCode).toBe(200);expect(f.lines).toHaveLength(0);}
    finally {await f.app.close();vi.restoreAllMocks();}
  });
  it('requires a genuine pool-bound proof and the exact Acceptance runtime', async () => {
    const f = await fixture();
    try {
      expect(() => createJourneyDiagnostic(f.pool, {} as AcceptanceServerProof, env)).toThrow(/verified/);
      for (const change of [{ NODE_ENV: 'production' }, { PORT: '3201' }, { SERVICE_NAME: 'production' }, { ACCEPTANCE_LAB_ENABLED: 'false' }, { HOST: '0.0.0.0' }, { DX_REWORK_ROOT: '/opt/dx-rework' }]) expect(createJourneyDiagnostic(f.pool, f.proof, { ...env, ...change })).toBeUndefined();
    } finally { await f.app.close(); }
  });
  it('default-off preserves the pool and response; exact route sampling counts cache and actual SQL separately', async () => {
    let enabled = false; const f = await fixture(() => enabled), original = f.pool.connect;
    try {
      expect((await f.app.inject('/digital-production/journeys')).json()).toEqual({ ok: true });
      expect(f.pool.connect).toBe(original); expect(f.lines).toHaveLength(0);
      enabled = true;
      await f.app.inject('/digital-production/journeys/PRIVATE-ID'); expect(f.lines).toHaveLength(0);
      const before = f.driverCalls();
      const response = await f.app.inject({ url: '/digital-production/journeys?private=PRIVATE-ID', headers: { cookie: 'secret-token', 'x-request-id': 'PRIVATE-ID' } });
      expect(response.json()).toEqual({ ok: true }); expect(f.driverCalls() - before).toBe(2);
      expect(f.lines).toHaveLength(1); expect(f.lines[0]).not.toMatch(/PRIVATE-ID|secret|SELECT|cookie|orders/);
      const record = f.record(); expect(record.calls.sql).toBe(2); expect(record.calls.pool_acquire).toBe(2); expect(record.cache_hits).toBe(1); expect(record.calls.route_auth).toBe(1); expect(record.calls.serialization_window).toBe(1); expect(record.calls.sla).toBe(0);
    } finally { await f.app.close(); }
  });
  it('caps at ten requests and suppresses revoked in-flight output', async () => {
    let enabled = true; const f = await fixture(() => enabled);
    f.app.addHook('onSend', async () => { enabled = false; });
    try { await f.app.inject('/digital-production/journeys'); expect(f.lines).toHaveLength(0); } finally { await f.app.close(); }
    const capped = await fixture();
    try { for (let i = 0; i < 12; i++) await capped.app.inject('/digital-production/journeys'); expect(capped.lines).toHaveLength(10); } finally { await capped.app.close(); }
  });
  it('does not turn output errors into business failures', async () => {
    const f = await fixture(() => true, () => { throw new Error('sink unavailable'); });
    try { expect((await f.app.inject('/digital-production/journeys')).statusCode).toBe(200); } finally { await f.app.close(); }
  });
  it('drops oversized and concurrent output, and handles asynchronous sink errors',()=>{
    let finish!:()=>void;
    vi.mocked(fs.write).mockImplementationOnce(((...args:unknown[])=>{finish=()=>Reflect.apply(args.at(-1) as (...values:unknown[])=>void,undefined,[new Error('TEST EPIPE')]);}) as typeof fs.write);
    const sink=createDiagnosticSink();
    sink('x'.repeat(4097));expect(fs.write).not.toHaveBeenCalled();
    sink('first\n');sink('dropped\n');expect(fs.write).toHaveBeenCalledTimes(1);
    expect(()=>finish()).not.toThrow();
    vi.mocked(fs.write).mockImplementationOnce((()=>{throw new Error('TEST synchronous sink error');}) as typeof fs.write);
    expect(()=>sink('after failure\n')).not.toThrow();expect(fs.write).toHaveBeenCalledTimes(2);
  });
  it('survives a real closed stdout pipe in a child process',async()=>{
    const source=new URL('../../apps/api/src/platform/journey-diagnostic.ts',import.meta.url).href;
    const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',`import {createDiagnosticSink} from ${JSON.stringify(source)};const sink=createDiagnosticSink();setTimeout(()=>sink('TEST closed pipe\\n'),30);setTimeout(()=>process.exit(0),80);`],{stdio:['ignore','pipe','pipe']});
    let error='';child.stderr.on('data',data=>{error+=String(data);});child.stdout.destroy();
    const [code]=await once(child,'exit');expect(code).toBe(0);expect(error).toBe('');
  });
  it('counts a sampled pool waiter when its connect callback is released outside its context',async()=>{
    const f=await fixture(),connect=f.pool.connect;
    let flush!:()=>void,entered!:()=>void;
    const queued=new Promise<void>(resolve=>{entered=resolve;});
    f.pool.connect=function(this:Pool,callback?:unknown){
      if(typeof callback==='function'){flush=()=>Reflect.apply(connect,this,[callback]);entered();return;}
      return Reflect.apply(connect,this,[]);
    } as Pool['connect'];
    try {
      const request=f.app.inject('/digital-production/journeys').then(r=>r);await queued;flush();
      expect((await request).statusCode).toBe(200);expect(f.driverCalls()).toBe(2);expect(f.record().calls.sql).toBe(2);
    } finally {await f.app.close();}
  });
  it('restores the query caller for chained SQL completed outside its context',async()=>{
    const f=await fixture(),client=await f.pool.connect(),query=client.query;
    let hold=true,flush!:()=>void,entered!:()=>void;
    const queued=new Promise<void>(resolve=>{entered=resolve;});
    client.query=function(this:PoolClient,...args:unknown[]){
      if(hold&&typeof args.at(-1)==='function'){hold=false;flush=()=>Reflect.apply(query,this,args);entered();return;}
      return Reflect.apply(query,this,args);
    } as PoolClient['query'];
    f.app.addHook('preHandler',async()=>{
      const scoped=await f.pool.connect();
      await new Promise<void>((resolve,reject)=>{
        scoped.query('TEST first',error=>{if(error){reject(error);return;}scoped.query('TEST chained',second=>second?reject(second):resolve());});
      });
    });
    try {
      const request=f.app.inject('/digital-production/journeys').then(r=>r);await queued;flush();
      expect((await request).statusCode).toBe(200);expect(f.driverCalls()).toBe(4);expect(f.record().calls.sql).toBe(4);
    } finally {await f.app.close();}
  });
  it('restores an undefined caller so background SQL cannot inherit a sampled request',async()=>{
    const f=await fixture(),client=await f.pool.connect(),query=client.query;
    let hold=false,flush!:()=>void,shouldFlush=false;
    let background:Promise<void>|undefined;
    f.app.addHook('preHandler',async()=>{if(shouldFlush){flush();await background;}});
    client.query=function(this:PoolClient,...args:unknown[]){
      if(hold&&typeof args.at(-1)==='function'){hold=false;flush=()=>Reflect.apply(query,this,args);return;}
      return Reflect.apply(query,this,args);
    } as PoolClient['query'];
    try {
      await f.app.inject('/digital-production/journeys');hold=true;
      background=new Promise<void>((resolve,reject)=>client.query('TEST outside',error=>{
        if(error){reject(error);return;}client.query('TEST outside chained',second=>second?reject(second):resolve());
      }));
      shouldFlush=true;
      expect((await f.app.inject('/digital-production/journeys')).statusCode).toBe(200);
      expect(f.driverCalls()).toBe(6);expect(JSON.parse(f.lines[1]!.slice('JOURNEY_DIAGNOSTIC '.length)).calls.sql).toBe(2);
    } finally {await f.app.close();}
  });
  it('samples only one concurrent request without mixing counters and preserves errors', async () => {
    const f = await fixture();
    let release!: () => void, entered!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    f.app.addHook('preHandler', async request => {
      if (request.headers['x-hold']) { entered(); await barrier; }
      if (request.headers['x-fail']) await journeyMeasure('clock_postcheck', async () => { throw Object.assign(new Error('PRIVATE-FAILURE'), { statusCode: 409 }); });
    });
    try {
      const first = f.app.inject({ url: '/digital-production/journeys', headers: { 'x-hold': 'yes' } }).then(r => r);
      await started;
      expect((await f.app.inject('/digital-production/journeys')).statusCode).toBe(200);
      release(); expect((await first).statusCode).toBe(200);
      expect(f.lines).toHaveLength(1); expect(f.record().calls.sql).toBe(2);
      expect((await f.app.inject({ url: '/digital-production/journeys', headers: { 'x-fail': 'yes' } })).statusCode).toBe(409);
      expect(f.lines).toHaveLength(2); expect(f.lines[1]).not.toContain('PRIVATE-FAILURE');
    } finally { release(); await f.app.close(); }
  });
});
