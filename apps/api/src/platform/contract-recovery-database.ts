import type { Pool } from "pg";

export const contractRecoveryTimeouts = "SET LOCAL lock_timeout='1s'; SET LOCAL statement_timeout='10s'";

/** Destroys only the worker's checked-out connection on cancellation. The
 * server then abandons an in-flight query or rolls back that session's work. */
export async function connectContractRecovery(database: Pool, signal: AbortSignal) {
  signal.throwIfAborted();
  const client = await database.connect();
  let released = false;
  const release = (destroy = false) => {
    if (released) return;
    released = true;
    signal.removeEventListener("abort", cancel);
    client.release(destroy);
  };
  const cancel = () => release(true);
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) {
    cancel();
    signal.throwIfAborted();
  }
  return { client, release };
}

export function contractRecoveryDatabase(database: Pool, signal?: AbortSignal): Pick<Pool, "query"> {
  if (!signal) return database;
  // Each acquisition uses the existing pool's connection timeout, and each
  // short operation has its own limit inside the wider job/stop deadline.
  const query = (async (text: string, values?: unknown[]) => {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
    const { client, release } = await connectContractRecovery(database, deadline);
    try {
      await client.query("BEGIN");
      await client.query(contractRecoveryTimeouts);
      const result = await client.query(text, values);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      // On cancellation the connection was destroyed. The server-side lock
      // and statement limits still stop commands already waiting in PostgreSQL.
      if (!deadline.aborted) {
        try { await client.query("ROLLBACK"); }
        catch { release(true); }
      }
      throw error;
    } finally {
      release();
    }
  }) as Pool["query"];
  return { query };
}
