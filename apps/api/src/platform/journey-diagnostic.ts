import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync, write } from 'node:fs';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { assertAcceptanceServerProof, type AcceptanceServerProof } from '../acceptance-clock/guard.js';

export const JOURNEY_DIAGNOSTIC_FILE = '/opt/dx-rework-acceptance/shared/journey-diagnostic.json';
const stages = ['clock_prehandler', 'route_auth', 'pool_acquire', 'candidates', 'selection','summary_projection', 'filter_page', 'detail_projection', 'bulk', 'closure', 'sla', 'clock_read', 'clock_postcheck', 'sql', 'serialization_window'] as const;
type Stage = typeof stages[number];
type Window = { key: string; expiresAt: number };
type Sample = { window: Window; deadline: number; id: string; start: number; closed: boolean; durations: Record<Stage, number>; calls: Record<Stage, number>; cacheHits: number; candidates: number; serializationStart?: number };
const context = new AsyncLocalStorage<Sample | undefined>();
const zeros = () => Object.fromEntries(stages.map(key => [key, 0])) as Record<Stage, number>;

/** Fixed labels only. No SQL, identifiers, request metadata or errors enter a sample. */
export function journeySpan(stage: Stage): () => void {
  const sample = context.getStore();
  if (!sample || sample.closed) return () => {};
  const start = performance.now();
  sample.calls[stage]++;
  let ended = false;
  return () => { if (!ended && !sample.closed) sample.durations[stage] += performance.now() - start; ended = true; };
}
export async function journeyMeasure<T>(stage: Stage, action: () => Promise<T>): Promise<T> {
  const end = journeySpan(stage);
  try { return await action(); } finally { end(); }
}
export function journeyCacheHit(): void { const sample = context.getStore(); if (sample && !sample.closed) sample.cacheHits++; }
export function journeyCandidateCount(count: number): void { const sample = context.getStore(); if (sample && !sample.closed) sample.candidates += count; }

/** Strict finite window in real UTC, not Acceptance's simulated business time. */
export function diagnosticWindow(value: unknown, now: number): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const config = value as Record<string, unknown>;
  if (Object.keys(config).sort().join(',') !== 'enabled,expiresAt,startedAt' || config.enabled !== true) return false;
  const utc = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
  if (typeof config.startedAt !== 'string' || typeof config.expiresAt !== 'string' || !utc.test(config.startedAt) || !utc.test(config.expiresAt)) return false;
  const start = Date.parse(config.startedAt), end = Date.parse(config.expiresAt);
  return Number.isFinite(start) && Number.isFinite(end) && start <= now && now < end && end - start > 0 && end - start <= 15 * 60_000;
}
/** Descriptor identity plus exact bounded contents prevents a replaced window resuming old samples. */
export function readDiagnosticLease(path = JOURNEY_DIAGNOSTIC_FILE): Window | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 512 || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600 || stat.nlink !== 1) return undefined;
    const buffer = Buffer.alloc(513), length = readSync(fd, buffer, 0, buffer.length, 0), after = fstatSync(fd);
    if (length !== stat.size || length > 512 || stat.size !== after.size || stat.ctimeMs !== after.ctimeMs || stat.mtimeMs !== after.mtimeMs || stat.mode !== after.mode || stat.uid !== after.uid || after.nlink !== 1) return undefined;
    const content = buffer.subarray(0, length).toString('utf8'), value = JSON.parse(content);
    if (!diagnosticWindow(value, Date.now())) return undefined;
    return { key: `${stat.dev}:${stat.ino}:${stat.ctimeMs}:${content}`, expiresAt: Date.parse(value.expiresAt) };
  } catch { return undefined; } finally { if (fd !== undefined) { try { closeSync(fd); } catch { /* Never fail the business request on diagnostic cleanup. */ } } }
}
export function readDiagnosticWindow(path = JOURNEY_DIAGNOSTIC_FILE): boolean { return readDiagnosticLease(path) !== undefined; }

/** At most one bounded async write; fs callback errors do not emit an uncaught stdout stream error. */
export function createDiagnosticSink(): (line: string) => void {
  let writing = false;
  return line => {
    if (writing || Buffer.byteLength(line) > 4096) return;
    writing = true;
    try { write(1, line, () => { writing = false; }); } catch { writing = false; }
  };
}

/** Instrument the actual client, below the snapshot cache; never count Pool.query twice.
 * Preserve pg's callback and promise overloads, `this`, errors and release behavior.
 * No arguments/results are inspected or retained by the instrumentation.
 */
export function instrumentJourneyPool(pool: Pool): void {
  const clients = new WeakSet<PoolClient>();
  const instrument = (client: PoolClient) => {
    if (clients.has(client)) return;
    clients.add(client);
    const original = client.query;
    client.query = function (this: PoolClient, ...args: unknown[]) {
      const caller = context.getStore(), end = journeySpan('sql');
      const last = args.length - 1, callback = args[last];
      if (typeof callback === 'function') args[last] = function (this: unknown, ...values: unknown[]) { end(); return context.run(caller, () => Reflect.apply(callback, this, values)); };
      try {
        const result = Reflect.apply(original, this, args);
        if (typeof callback === 'function') return result;
        if (result && typeof result.then === 'function') return result.then((value: unknown) => { end(); return value; }, (error: unknown) => { end(); throw error; });
        end(); return result;
      } catch (error) { end(); throw error; }
    } as PoolClient['query'];
  };
  const connect = pool.connect;
  pool.connect = function (this: Pool, callback?: (...args: unknown[]) => unknown) {
    const caller = context.getStore(), end = journeySpan('pool_acquire');
    if (callback) {
      try { return Reflect.apply(connect, this, [function (this: unknown, error: unknown, client: PoolClient | undefined, release: unknown) {
        end(); if (client) instrument(client); return context.run(caller, () => Reflect.apply(callback, this, [error, client, release]));
      }]); } catch (error) { end(); throw error; }
    }
    try { return Reflect.apply(connect, this, []).then((client: PoolClient) => { end(); instrument(client); return client; }, (error: unknown) => { end(); throw error; }); }
    catch (error) { end(); throw error; }
  } as Pool['connect'];
}

export type JourneyDiagnostic = { register: (app: FastifyInstance) => void };
/** Internal factory: callers must supply the boot-verified proof for this exact pool. */
export function createJourneyDiagnostic(pool: Pool, proof: AcceptanceServerProof, environment: NodeJS.ProcessEnv = process.env,
  controls: { window?: () => Window | undefined; enabled?: () => boolean; emit?: (line: string) => void } = {}): JourneyDiagnostic | undefined {
  assertAcceptanceServerProof(pool, proof);
  if (environment.NODE_ENV !== 'test' || environment.ACCEPTANCE_LAB_ENABLED !== 'true' || environment.SERVICE_NAME !== 'dx-rework-acceptance-api'
    || environment.HOST !== '127.0.0.1' || environment.PORT !== '3202' || environment.DX_REWORK_ROOT !== '/opt/dx-rework-acceptance') return undefined;
  const readWindow = (): Window | undefined => {
    try { if (controls.window) return controls.window(); return controls.enabled ? (controls.enabled() ? { key: 'test-window', expiresAt: Date.now() + 900_000 } : undefined) : readDiagnosticLease(); } catch { return undefined; }
  };
  const emit = controls.emit ?? createDiagnosticSink();
  let observedWindow: { key: string; deadline: number } | undefined;
  let reserved = 0, active = false, installed = false;
  const samples = new WeakMap<FastifyRequest, Sample>();
  return { register(app) {
    app.addHook('onRequest', (request, reply, done) => {
      if (request.method !== 'GET' || request.routeOptions.url !== '/digital-production/journeys' || active || reserved >= 10) { done(); return; }
      const window = readWindow(); if (!window) { done(); return; }
      if (observedWindow?.key !== window.key) observedWindow = { key: window.key, deadline: performance.now() + Math.min(900_000, window.expiresAt - Date.now()) };
      if (performance.now() >= observedWindow.deadline) { done(); return; }
      if (!installed) { instrumentJourneyPool(pool); installed = true; }
      reserved++; active = true;
      const sample: Sample = { window, deadline: observedWindow.deadline, id: randomUUID(), start: performance.now(), closed: false, durations: zeros(), calls: zeros(), cacheHits: 0, candidates: 0 };
      samples.set(request, sample);
      // A disconnected request must not keep the single sample slot reserved.
      reply.raw.once('close', () => { if (!sample.closed) { sample.closed = true; active = false; samples.delete(request); } });
      context.run(sample, done);
    });
    app.addHook('preSerialization', async request => { const sample = samples.get(request); if (sample) sample.serializationStart = performance.now(); });
    app.addHook('onSend', async (request, _reply, payload) => {
      const sample = samples.get(request);
      if (sample?.serializationStart !== undefined) { sample.durations.serialization_window += performance.now() - sample.serializationStart; sample.calls.serialization_window++; delete sample.serializationStart; }
      return payload;
    });
    app.addHook('onResponse', async (request, reply) => {
      const sample = samples.get(request); if (!sample || sample.closed) return;
      sample.closed = true; active = false; samples.delete(request);
      // Revocation/expiry also suppresses output from requests already in flight.
      if (readWindow()?.key !== sample.window.key || performance.now() >= sample.deadline) return;
      const round = (value: number) => Math.round(value * 1000) / 1000;
      try { emit(`JOURNEY_DIAGNOSTIC ${JSON.stringify({ version: 1, sample: sample.id, status: reply.statusCode, request_ms: round(performance.now() - sample.start), ms: Object.fromEntries(stages.map(key => [key, round(sample.durations[key])])), calls: sample.calls, candidates: sample.candidates, cache_hits: sample.cacheHits })}\n`); } catch { /* Diagnostics must not change business responses. */ }
    });
  } };
}
