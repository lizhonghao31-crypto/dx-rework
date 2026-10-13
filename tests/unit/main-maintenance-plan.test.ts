import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const plans = JSON.parse(readFileSync("scripts/deploy/main-maintenance-plans.json", "utf8"));
const manifest = JSON.parse(readFileSync("apps/api/src/platform/migration-manifest.json", "utf8"));
const versions = ["0223_sourcing_factory_change_craft_names","0224_contract_version_review_transfer_delivery"] as const;

function check(version: string, mode = "allowed", oldPlans = false, drift = false) {
  const selectedManifest={...manifest,migrations:manifest.migrations.filter((row: {version:string})=>row.version<=version)};
  const fixture = mkdtempSync(join(tmpdir(), "main-plan-"));
  try {
    mkdirSync(join(fixture, "scripts/deploy"), { recursive: true });
    for (const file of ["deploy/check-main-maintenance-plan.mjs", "migration-history-policy.mjs", "migration-branches.json", "migration-main-extensions.json"]) {
      cpSync(join(root, "scripts", file), join(fixture, "scripts", file));
    }
    writeFileSync(join(fixture, "scripts/deploy/main-maintenance-plans.json"), JSON.stringify(oldPlans ? plans.filter((p: { version: string }) => p.version !== version) : plans));
    mkdirSync(join(fixture, "node_modules/pg"), { recursive: true });
    writeFileSync(join(fixture, "node_modules/pg/package.json"), '{"type":"module","exports":"./index.js"}');
    const history = mode === "current" ? selectedManifest.migrations : selectedManifest.migrations.slice(0, -1);
    writeFileSync(join(fixture, "data.json"), JSON.stringify({ mode, history }));
    writeFileSync(join(fixture, "node_modules/pg/index.js"), `
      import { readFileSync, appendFileSync } from 'node:fs';
      const data=JSON.parse(readFileSync(process.env.PLAN_FIXTURE+'/data.json'));
      export default {Client:class {
        async connect() {} async end() {}
        async query(sql) {
          appendFileSync(process.env.PLAN_FIXTURE+'/queries.jsonl',JSON.stringify(sql)+'\\n');
          if(sql.includes('FROM schema_migrations')) return {rows:data.history};
          if(sql.includes('FROM pg_class')) return {rows:[{owns:data.mode!=='table'}]};
          if(sql.includes('has_table_privilege')) return {rows:[{allowed:data.mode!=='trigger'}]};
          if(sql.includes('current_schema()')) return {rows:[{allowed:!['schema','shadow-schema'].includes(data.mode)}]};
          if(sql.includes('FROM pg_proc')) return {rows:data.mode==='missing-function'?[]:[{allowed:data.mode!=='function'}]};
          if(sql.includes('has_language_privilege')) return {rows:[{allowed:data.mode!=='language'}]};
          return {rows:[]};
        }
      }};
    `);
    const source = join(fixture, "source");
    mkdirSync(join(source, "apps/api/src/platform"), { recursive: true });
    mkdirSync(join(source, "apps/api/migrations"), { recursive: true });
    writeFileSync(join(source, "apps/api/src/platform/migration-manifest.json"), JSON.stringify(selectedManifest));
    writeFileSync(join(source, `apps/api/migrations/${version}.sql`), readFileSync(`apps/api/migrations/${version}.sql`, "utf8") + (drift ? "\n" : ""));
    const result = spawnSync(process.execPath, [join(fixture, "scripts/deploy/check-main-maintenance-plan.mjs"), source], {
      encoding: "utf8", env: { ...process.env, PLAN_FIXTURE: fixture },
    });
    const queries: string[] = readFileSync(join(fixture, "queries.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(queries[0]).toContain("BEGIN READ ONLY");
    expect(queries.at(-1)).toBe("ROLLBACK");
    expect(queries.every(sql => /^(SELECT|BEGIN READ ONLY|ROLLBACK)/.test(sql))).toBe(true);
    return result;
  } finally { rmSync(fixture, { recursive: true, force: true }); }
}

describe.each(versions)("%s main maintenance admission", version => {
  const run=(mode="allowed",oldPlans=false,drift=false)=>check(version,mode,oldPlans,drift);
  const current=version.startsWith("0224");
  it("admits the exact plan while retaining maintenance-only routing", () => {
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ pending: [version], onlineAllowed: false });
    expect(plans.find((p: { version: string }) => p.version === version)).toMatchObject({
      checksum: manifest.migrations.find((row: {version:string})=>row.version===version).checksum,
      tables: current ? ["public.sourcing_case_transitions"] : ["public.craft_catalog_versions"], schema: "public",
      triggerTables: current ? ["public.sourcing_factory_change_requests","public.sourcing_approval_snapshots"] : ["public.craft_catalog_versions"],
      functions: current ? ["public.guard_sourcing_contract_content_creation()","public.guard_sourcing_transition_insert()","public.sourcing_effective_delivery_date(uuid,date,timestamp with time zone)"] : ["public.guard_craft_catalog_version_creation()"], languages: ["plpgsql"],
      onlineCompatible: false,
    });
  });
  it("rejects the old installed plan before maintenance", () => {
    expect(run("allowed", true).stderr).toContain(`MIGRATION_PLAN_REQUIRED: ${version}`);
  });
  it("rejects SQL fingerprint drift", () => {
    expect(run("allowed", false, true).stderr).toContain("Migration plan fingerprint drift");
  });
  it.each([
    ["table", current ? "public.sourcing_case_transitions" : "public.craft_catalog_versions"],
    ["trigger", current ? "table public.sourcing_factory_change_requests TRIGGER" : "table public.craft_catalog_versions TRIGGER"],
    ["schema", "schema public USAGE/CREATE/current_schema"],
    ["shadow-schema", "schema public USAGE/CREATE/current_schema"],
    ["function", current ? "function public.guard_sourcing_contract_content_creation() owner" : "function public.guard_craft_catalog_version_creation() owner"],
    ["missing-function", current ? "function public.guard_sourcing_contract_content_creation() owner" : "function public.guard_craft_catalog_version_creation() owner"],
    ["language", "language plpgsql USAGE"],
  ])("rejects insufficient %s permission without writes", (mode, object) => {
    const result = run(mode);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`MIGRATION_PERMISSION_REQUIRED: ${object}`);
  });
  it("requires no new DDL permissions once the full history is current", () => {
    const result = run("current");
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ pending: [], onlineAllowed: true });
  });
  it("checks admission before routing changes and preserves committed-DDL recovery rules", () => {
    const prepare = readFileSync("scripts/deploy/prepare-online-candidate.sh", "utf8");
    expect(prepare.indexOf("check-main-maintenance-plan.mjs")).toBeLessThan(prepare.indexOf('bundle="$DX_ROOT/candidates/$sha"'));
    const controller = readFileSync("scripts/deploy/update-main-maintenance.sh", "utf8");
    expect(controller.indexOf('worker prepare-online-candidate.sh "$snapshot" maintenance')).toBeLessThan(controller.indexOf('link_config "$state/maintenance.conf"'));
    expect(controller).toContain('worker apply-main-maintenance.sh verify "$active_sha" >/dev/null || return');
    expect(controller).toContain('retry the SAME frozen candidate');
    expect(controller).toContain('maintenance-migrated');
    expect(controller).toContain('candidate activation failed after migration; maintenance retained, no old-schema rollback');
  });
});
