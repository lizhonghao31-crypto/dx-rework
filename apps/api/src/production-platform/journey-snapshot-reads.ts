import {journeyCacheHit} from '../platform/journey-diagnostic.js';
import {journeySnapshotBatches} from './journey-snapshot-batches.js';
import type { PoolClient, QueryResult } from "pg";

const MAX_BYTES = 4 * 1024 * 1024;
const MAX_ENTRIES = 1024;
const MAX_CLASSIFICATION_BYTES = 256 * 1024;
const batchScopes=new WeakMap<PoolClient,ReturnType<typeof journeySnapshotBatches>>();
/** The caller supplies only candidates with its original full management read range. */
export function prepareJourneySnapshotBatches(client:PoolClient,orderIds:readonly string[]):void{batchScopes.get(client)?.scope(orderIds);}
const unsafeRead = /\bFOR\s+(?:KEY\s+SHARE|SHARE|NO\s+KEY\s+UPDATE|UPDATE)\b|\b(insert|update|delete|merge|lock|copy|call|set|reset)\b|\b(nextval|setval|set_config|pg_(?:try_)?advisory_\w+|clock_timestamp|statement_timestamp|timeofday|random|gen_random_uuid|pg_sleep)\s*\(/i;
/** Inspect SQL tokens, not business text such as 'receiving.batch.merge'.
 * Stay conservative for syntax this small scanner does not interpret. The
 * original SQL and parameters always go to pg unchanged. */
const readTokens = (statement: string): string | null => {
  if (/--|\/\*|\\|\$(?:[a-z_][a-z_0-9]*)?\$/i.test(statement)) return null;
  let tokens = "";
  for (let index = 0; index < statement.length; index++) {
    const character = statement[index]!;
    if (character === '"') {
      let identifier = "", closed = false;
      while (++index < statement.length) {
        if (statement[index] !== '"') { identifier += statement[index]; continue; }
        if (statement[index + 1] === '"') { identifier += '"'; index++; continue; }
        closed = true; break;
      }
      if (!closed) return null;
      tokens += ` ${identifier} `; continue;
    }
    if (character !== "'") { tokens += character; continue; }
    tokens += "''";
    let closed = false;
    while (++index < statement.length) {
      if (statement[index] !== "'") continue;
      if (statement[index + 1] === "'") { index++; continue; }
      closed = true; break;
    }
    if (!closed) return null;
  }
  return tokens;
};
const scalar = (value: unknown): boolean => value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value) || Array.isArray(value) && value.every(scalar);
const plainRows = (value: unknown): boolean => value === null || typeof value !== "object" || value instanceof Date
  || Array.isArray(value) && value.every(plainRows)
  || Object.getPrototypeOf(value) === Object.prototype && Object.values(value).every(plainRows);
const copy = (result: QueryResult): QueryResult => Object.assign(Object.create(Object.getPrototypeOf(result)), result, { rows: structuredClone(result.rows) });

/** Only for Journey's single-actor REPEATABLE READ READ ONLY transaction.
 * No result survives that snapshot. Keep the original SQL/parameters and policy
 * decisions; reuse identical reads rather than re-reading their immutable facts.
 */
export function reuseJourneySnapshotReads(client: PoolClient): PoolClient {
  const batches=journeySnapshotBatches(client);
  const cache = new Map<string, { result: QueryResult; bytes: number }>();
  // Classification depends only on the exact immutable SQL text. The original
  // pagination workload repeatedly scans the same large task query even on a
  // result-cache hit. Reuse that lexical decision, never its parameters,
  // authorization or query result. Context changes still clear result reuse.
  const classifications = new Map<string, { safe: boolean; bytes: number }>();
  let classificationBytes = 0;
  const reusable = (text: string): boolean => {
    const hit = classifications.get(text);
    if (hit) return hit.safe;
    const statement = text.trim().replace(/;\s*$/, ""), tokens = readTokens(statement);
    const safe = /^(SELECT|WITH)\b/i.test(statement) && tokens !== null && !unsafeRead.test(tokens) && !statement.includes(";");
    const bytes = Buffer.byteLength(text);
    if (bytes <= MAX_CLASSIFICATION_BYTES) {
      while (classifications.size >= MAX_ENTRIES || classificationBytes + bytes > MAX_CLASSIFICATION_BYTES) {
        const key = classifications.keys().next().value!;
        classificationBytes -= classifications.get(key)!.bytes; classifications.delete(key);
      }
      classifications.set(text, { safe, bytes }); classificationBytes += bytes;
    }
    return safe;
  };
  let retained = 0, generation = 0;
  const clear = () => { cache.clear(); batches.clear(); retained = 0; generation++; };
  const remove = (key: string) => { retained -= cache.get(key)?.bytes ?? 0; cache.delete(key); };
  const query = (...args: unknown[]) => {
    const text = args[0], values = args[1] ?? [];
    if (typeof text !== "string" || !reusable(text)
      || args.length > 2 || !Array.isArray(values) || !values.every(scalar)) {
      // Also invalidate on session-context changes or unsupported query modes.
      clear(); return Reflect.apply(client.query, client, args);
    }
    const key = `${text}\u0000${JSON.stringify(values)}`, hit = cache.get(key);
    if (hit) { journeyCacheHit(); cache.delete(key); cache.set(key, hit); return Promise.resolve(copy(hit.result)); }
    const started = generation;
    let requested:Promise<QueryResult>;
    try{requested=batches.read(text as string,values)??Reflect.apply(client.query, client, args) as Promise<QueryResult>;}
    catch(error){clear();throw error;}
    return requested.then(result => {
      if (started !== generation || result.rows.length > 128 || !plainRows(result.rows)) return result;
      let bytes: number;
      try { bytes = Buffer.byteLength(key) + Buffer.byteLength(JSON.stringify([result.rows, result.fields])); }
      catch { return result; }
      if (bytes > MAX_BYTES) return result;
      remove(key);
      while (cache.size >= MAX_ENTRIES || retained + bytes > MAX_BYTES) remove(cache.keys().next().value!);
      cache.set(key, { result: copy(result), bytes }); retained += bytes;
      return result;
    }, error => {
      // A failed statement can abort PostgreSQL's transaction. Never let a
      // cached hit conceal that failure if a caller catches and continues.
      clear(); throw error;
    });
  };
  const proxy=new Proxy(client, { get(target, key) {
    if (key === "query") return query;
    const value = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  batchScopes.set(proxy,batches);return proxy;
}

const COHORT_SIZE=32;
const COHORT_SQL_BYTES=256*1024;
const COHORT_INDEX='__dx_cockpit_candidate';
const COHORT_ROW='__dx_cockpit_result';
const cohortIdentifiers=new RegExp(`${COHORT_INDEX}|${COHORT_ROW}`,'i');
function cloneCohortValue<T>(value:T):T {
 if(Buffer.isBuffer(value))return Buffer.from(value) as T;
 if(value instanceof Date)return new Date(value.getTime()) as T;
 if(Array.isArray(value))return value.map(cloneCohortValue) as T;
 if(value&&typeof value==='object'&&Object.getPrototypeOf(value)===Object.prototype){
  return Object.fromEntries(Object.entries(value).map(([key,entry])=>[key,cloneCohortValue(entry)])) as T;
 }
 return value;
}
const bindMarker=/'(?:[^']|'')*'|"(?:[^"]|"")*"|\$([1-9][0-9]*)\b/g;
type CohortRead={statement:string;args:unknown[];resolve:(result:QueryResult)=>void;reject:(error:unknown)=>void};

/** Execute identical native SELECT shapes as one ordered SQL read on the
 * caller's read-only snapshot. Bindings keep their original inference and pg
 * decoders. Native evaluators retain their own authorization and branching. */
export async function readJourneyCandidateCohort<T,R>(db:PoolClient,candidates:readonly T[],read:(client:PoolClient,candidate:T)=>Promise<R>):Promise<R[]>{
 const results:R[]=[];
 for(let offset=0;offset<candidates.length;offset+=COHORT_SIZE){
  const pending:CohortRead[]=[];
  let draining=false,failed=false,failure:unknown;
  const dispatch=async(group:CohortRead[])=>{
   const first=group[0]!;
   if(group.length===1){first.resolve(await db.query(first.statement,first.args));return;}
   const unique=[...new Map(group.map(entry=>[JSON.stringify(entry.args),entry])).values()];
   if(unique.length===1){
    const result=await db.query(first.statement,first.args);
    for(const entry of group)entry.resolve({...result,rows:cloneCohortValue(result.rows)});
    return;
   }
   const args:unknown[]=[],indexes=new Map<string,number>();
   const parts=unique.map((entry,index)=>{
    indexes.set(JSON.stringify(entry.args),index);
    const statement=entry.statement.replace(bindMarker,(match,digit:string|undefined)=>digit?`$${args.length+Number(digit)}`:match);
    args.push(...entry.args);
    return `SELECT ${index} AS "${COHORT_INDEX}",row_number() OVER () AS "${COHORT_ROW}",original.* FROM (${statement}) original`;
   });
   const result=await db.query(`${parts.join(' UNION ALL ')} ORDER BY "${COHORT_INDEX}","${COHORT_ROW}"`,args);
   if(result.fields.filter(field=>field.name===COHORT_INDEX).length!==1||
      result.fields.filter(field=>field.name===COHORT_ROW).length!==1)throw Error('Missing cockpit candidate result metadata');
   const rows=Array.from({length:unique.length},()=>[] as QueryResult['rows']);
   for(const {[COHORT_INDEX]:index,[COHORT_ROW]:ordinal,...row} of result.rows){
    if(!Number.isInteger(index)||!rows[index]||ordinal==null)throw Error('Invalid cockpit candidate result scope');
    rows[index].push(row);
   }
   const fields=result.fields.filter(field=>field.name!==COHORT_INDEX&&field.name!==COHORT_ROW);
   for(const entry of group){
    const matches=cloneCohortValue(rows[indexes.get(JSON.stringify(entry.args))!]!);
    entry.resolve({...result,fields,rows:matches,rowCount:matches.length});
   }
  };
  const drain=async()=>{
   while(pending.length){
    const wave=pending.splice(0),groups=new Map<string,CohortRead[]>();
    for(const [i,entry] of wave.entries()){
     const tokens=readTokens(entry.statement);
     const batchable=/^(SELECT|WITH)\b/i.test(entry.statement)&&tokens!==null&&!unsafeRead.test(tokens)
      &&!entry.statement.includes(';')&&!cohortIdentifiers.test(entry.statement)
      &&Buffer.byteLength(entry.statement)*COHORT_SIZE<=COHORT_SQL_BYTES
      &&entry.args.length*COHORT_SIZE<=32767&&entry.args.every(scalar);
     const key=batchable?entry.statement:String(i),group=groups.get(key)??[];
     group.push(entry);groups.set(key,group);
    }
    for(const group of groups.values()){
     try{
      if(failed)throw failure;
      await dispatch(group);
     }catch(error){failed=true;failure=error;for(const entry of group)entry.reject(error);}
    }
   }
   draining=false;
  };
  const query=(sql:string,values:unknown[]=[])=>new Promise<QueryResult>((resolve,reject)=>{
   if(failed){reject(failure);return;}
   pending.push({statement:sql.trim().replace(/;\s*$/,''),args:values,resolve,reject});
   if(!draining){draining=true;queueMicrotask(()=>void drain());}
  });
  const client=new Proxy(db,{get(target,key){return key==='query'?query:Reflect.get(target,key,target);}});
  // Drain every branch before returning to the savepoint owner, even on error.
  const settled=await Promise.allSettled(candidates.slice(offset,offset+COHORT_SIZE).map(candidate=>read(client,candidate)));
  for(const outcome of settled){if(outcome.status==='rejected')throw outcome.reason;results.push(outcome.value);}
 }
 return results;
}
