import type { PoolClient, QueryResult } from "pg";

const MAX_BYTES = 4 * 1024 * 1024;
const MAX_ENTRIES = 1024;
const unsafeRead = /\bFOR\s+(?:KEY\s+SHARE|SHARE|NO\s+KEY\s+UPDATE|UPDATE)\b|\b(insert|update|delete|merge|lock|copy|call|set|reset)\b|\b(nextval|setval|set_config|pg_(?:try_)?advisory_\w+|clock_timestamp|statement_timestamp|timeofday|random|gen_random_uuid|pg_sleep)\s*\(/i;
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
  const cache = new Map<string, { result: QueryResult; bytes: number }>();
  let retained = 0, generation = 0;
  const clear = () => { cache.clear(); retained = 0; generation++; };
  const remove = (key: string) => { retained -= cache.get(key)?.bytes ?? 0; cache.delete(key); };
  const query = (...args: unknown[]) => {
    const text = args[0], values = args[1] ?? [];
    const statement = typeof text === "string" ? text.trim().replace(/;\s*$/, "") : "";
    if (!/^(SELECT|WITH)\b/i.test(statement) || unsafeRead.test(statement) || statement.includes(";")
      || args.length > 2 || !Array.isArray(values) || !values.every(scalar)) {
      // Also invalidate on session-context changes or unsupported query modes.
      clear(); return Reflect.apply(client.query, client, args);
    }
    const key = `${text}\u0000${JSON.stringify(values)}`, hit = cache.get(key);
    if (hit) { cache.delete(key); cache.set(key, hit); return Promise.resolve(copy(hit.result)); }
    const started = generation;
    return (Reflect.apply(client.query, client, args) as Promise<QueryResult>).then(result => {
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
  return new Proxy(client, { get(target, key) {
    if (key === "query") return query;
    const value = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
}
