import { readFile } from "node:fs/promises";
import { describe,expect,it } from "vitest";
const sql=await readFile(new URL("../../apps/api/migrations/0004_public_tools_foundation.sql",import.meta.url),"utf8");
const repositories=await readFile(new URL("../../apps/api/src/tools/repositories.ts",import.meta.url),"utf8");
describe("public tools migration invariants",()=>{
 it.each(["idempotency_records","operation_events","message_outbox","attachments","export_jobs"])("creates %s",table=>expect(sql).toContain(`CREATE TABLE ${table}`));
 it("enforces append-only events and safe concurrent claims",()=>{expect(sql).toContain("operation_events_no_update");expect(sql).toContain("operation_events_no_delete");expect(repositories).toContain("SKIP LOCKED");});
 it("does not persist public attachment URLs and has uniqueness guards",()=>{expect(sql).not.toMatch(/public_url|download_url|upload_url/i);expect(sql).toContain("PRIMARY KEY (scope, actor_key, idempotency_key)");expect(sql).toContain("UNIQUE (topic, recipient_key, idempotency_key)");});
 it("references the PR-02 app_users identity table only",()=>{expect(sql.match(/REFERENCES app_users\(id\)/g)).toHaveLength(3);expect(sql).not.toContain("REFERENCES users");});
});
