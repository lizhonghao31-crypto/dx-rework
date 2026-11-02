import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const plans = JSON.parse(readFileSync("scripts/deploy/main-maintenance-plans.json", "utf8"));
const manifest = JSON.parse(readFileSync("apps/api/src/platform/migration-manifest.json", "utf8"));
const supportedMigrations: { version: string; checksum: string }[] = manifest.migrations.filter((row: { version: string }) => row.version >= "0222_");
const versions = ["0223_sourcing_factory_change_craft_names","0224_contract_version_review_transfer_delivery","0225_warehouse_supervisor_cutting_read","0226_external_revision_preserve_handler","0227_qc_other_craft","0230_sourcing_factory_change_current_quantity","0231_temporary_special_process_proxy_reporting"] as const;

function check(version: string, mode = "allowed", oldPlans = false, drift = false, options: { deniedObject?: string; planChecksumDrift?: boolean } = {}) {
  const selectedManifest={...manifest,migrations:manifest.migrations.filter((row: {version:string})=>row.version<=version)};
  const fixture = mkdtempSync(join(tmpdir(), "main-plan-"));
  try {
    mkdirSync(join(fixture, "scripts/deploy"), { recursive: true });
    for (const file of ["deploy/check-main-maintenance-plan.mjs", "migration-history-policy.mjs", "migration-branches.json", "migration-main-extensions.json"]) {
      cpSync(join(root, "scripts", file), join(fixture, "scripts", file));
    }
    const installedPlans = oldPlans ? plans.filter((p: { version: string }) => p.version !== version) : plans;
    writeFileSync(join(fixture, "scripts/deploy/main-maintenance-plans.json"), JSON.stringify(options.planChecksumDrift ? installedPlans.map((plan: { version: string; checksum: string }) => plan.version === version ? { ...plan, checksum: "0".repeat(64) } : plan) : installedPlans));
    mkdirSync(join(fixture, "node_modules/pg"), { recursive: true });
    writeFileSync(join(fixture, "node_modules/pg/package.json"), '{"type":"module","exports":"./index.js"}');
    const history = mode === "current" ? selectedManifest.migrations : selectedManifest.migrations.slice(0, -1);
    writeFileSync(join(fixture, "data.json"), JSON.stringify({ mode, history, deniedObject: options.deniedObject }));
    writeFileSync(join(fixture, "node_modules/pg/index.js"), `
      import { readFileSync, appendFileSync } from 'node:fs';
      const data=JSON.parse(readFileSync(process.env.PLAN_FIXTURE+'/data.json'));
      const denied=(mode,object)=>data.mode===mode&&(!data.deniedObject||data.deniedObject===object);
      export default {Client:class {
        async connect() {} async end() {}
        async query(sql, params) {
          appendFileSync(process.env.PLAN_FIXTURE+'/queries.jsonl',JSON.stringify(sql)+'\\n');
          if(sql.includes('FROM schema_migrations')) return {rows:data.history};
          if(sql.includes('FROM pg_class')) return {rows:[{owns:!denied('table',params[0]) && !(data.mode==='table-second' && params[0].includes('rework_process_configuration_items'))}]};
          if(sql.includes('has_table_privilege')) return {rows:[{allowed:!denied('trigger',params[0]) && !(data.mode==='trigger-second' && params[0].includes('rework_process_configuration_items'))}]};
          if(sql.includes('current_schema()')) return {rows:[{allowed:!['schema','shadow-schema'].includes(data.mode)}]};
          if(sql.includes('FROM pg_proc')) return {rows:denied('missing-function',params[0])?[]:[{allowed:!denied('function',params[0])}]};
          if(sql.includes('has_language_privilege')) return {rows:[{allowed:!denied('language',params[0]) && !(data.mode==='plpgsql' && params[0]==='plpgsql')}]};
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
    if (mode === "current") expect(queries).toHaveLength(3);
    return result;
  } finally { rmSync(fixture, { recursive: true, force: true }); }
}

describe("supported main maintenance plan coverage", () => {
  it("has no duplicate plan versions", () => {
    const planVersions = plans.map((plan: { version: string }) => plan.version);
    expect(new Set(planVersions).size).toBe(planVersions.length);
    expect(supportedMigrations[0]?.version).toBe("0222_sourcing_cutting_approved_line_identity");
  });
  it.each(supportedMigrations)("$version has one exact plan and SQL checksum", migration => {
    const matching = plans.filter((plan: { version: string }) => plan.version === migration.version);
    expect(matching).toHaveLength(1);
    expect(matching[0]?.checksum).toBe(migration.checksum);
    expect(createHash("sha256").update(readFileSync(`apps/api/migrations/${migration.version}.sql`)).digest("hex")).toBe(migration.checksum);
  });
});

const pmcPlan = {
  version: "0232_pmc_readonly_role",
  checksum: "31d01d06ce698735c21b2e8b9ab5f2f1da29d2ceb0838a130320e32e2bbe6547",
  strategy: "quiesce-backup-transactional-ddl",
  tables: ["public.business_roles", "public.capability_catalog", "public.role_capabilities"],
  triggerTables: ["public.attachments"],
  schema: "public",
  functions: [
    "public.access_authorized_actor_roles(uuid,text)",
    "public.pattern_room_authorized_order_roles(uuid,text)",
    "public.pattern_room_authorized_price_roles(uuid,text)",
    "public.cutting_authorized_roles(uuid,text)",
    "public.finance_authorized_wage_roles(uuid,text)",
    "public.external_responsibility_can_view_all(uuid)",
    "public.own_factory_approval_can_view(uuid,uuid)",
    "public.supplier_onboarding_authorized_roles(uuid,text)",
  ],
  languages: ["sql", "plpgsql"],
  onlineCompatible: false,
  rollback: "restart-previous-only-if-entire-history-unchanged",
};

describe("0232 PMC main maintenance admission", () => {
  it("admits the exact plan without requiring ownership of the new attachment guard", () => {
    expect(plans.find((plan: { version: string }) => plan.version === pmcPlan.version)).toEqual(pmcPlan);
    const result = check(pmcPlan.version, "missing-function", false, false, { deniedObject: "public.guard_pmc_attachment_upload()" });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ pending: [pmcPlan.version], onlineAllowed: false });
  });
  it("rejects an old installed tool without the PMC plan", () => {
    const result = check(pmcPlan.version, "allowed", true);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`MIGRATION_PLAN_REQUIRED: ${pmcPlan.version}`);
  });
  it("rejects a plan whose checksum does not match the candidate manifest", () => {
    const result = check(pmcPlan.version, "allowed", false, false, { planChecksumDrift: true });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`MIGRATION_PLAN_REQUIRED: ${pmcPlan.version}`);
  });
  it("rejects changed PMC SQL before any DDL permission checks", () => {
    const result = check(pmcPlan.version, "table", false, true);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Migration plan fingerprint drift");
  });
  it.each([
    ...pmcPlan.tables.map(object => ({ mode: "table", object, message: object })),
    ...pmcPlan.triggerTables.map(object => ({ mode: "trigger", object, message: `table ${object} TRIGGER` })),
    ...["schema", "shadow-schema"].map(mode => ({ mode, object: "public", message: "schema public USAGE/CREATE/current_schema" })),
    ...pmcPlan.functions.flatMap(object => ["function", "missing-function"].map(mode => ({ mode, object, message: `function ${object} owner` }))),
    ...pmcPlan.languages.map(object => ({ mode: "language", object, message: `language ${object} USAGE` })),
  ])("rejects $mode on $object without writes", ({ mode, object, message }) => {
    const result = check(pmcPlan.version, mode, false, false, { deniedObject: object });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`MIGRATION_PERMISSION_REQUIRED: ${message}`);
  });
  it("needs no PMC plan or DDL permissions after the complete history is current", () => {
    const result = check(pmcPlan.version, "current", true);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ pending: [], onlineAllowed: true });
  });
});

describe.each(versions)("%s main maintenance admission", version => {
  const run=(mode="allowed",oldPlans=false,drift=false)=>check(version,mode,oldPlans,drift);
  const current=version.startsWith("0224");
  const warehouse=version.startsWith("0225");
  const revision=version.startsWith("0226");
  const craft=version.startsWith("0227");
  const quantity=version.startsWith("0230");
  const proxy=version.startsWith("0231");
  it("admits the exact plan while retaining maintenance-only routing", () => {
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ pending: [version], onlineAllowed: false });
    expect(plans.find((p: { version: string }) => p.version === version)).toMatchObject({
      checksum: manifest.migrations.find((row: {version:string})=>row.version===version).checksum,
      tables: craft ? ["public.rework_orders","public.rework_process_configuration_items"] : revision || quantity || proxy ? [] : warehouse ? ["public.business_roles","public.role_capabilities"] : current ? ["public.sourcing_case_transitions"] : ["public.craft_catalog_versions"], schema: "public",
      triggerTables: craft ? ["public.rework_orders","public.rework_process_configuration_items"] : revision || quantity || proxy ? [] : warehouse ? ["public.business_roles","public.role_capabilities"] : current ? ["public.sourcing_factory_change_requests","public.sourcing_approval_snapshots"] : ["public.craft_catalog_versions"],
      functions: proxy ? ["public.guard_rework_work_report_insert()"] : quantity ? ["public.guard_sourcing_factory_change_request_insert()"] : craft ? ["public.guard_rework_order_write()"] : revision ? ["public.guard_determination_insert()"] : warehouse ? ["public.receiving_authorized_board_operator(uuid,text)","public.cutting_authorized_roles(uuid,text)"] : current ? ["public.guard_sourcing_contract_content_creation()","public.guard_sourcing_transition_insert()","public.sourcing_effective_delivery_date(uuid,date,timestamp with time zone)"] : ["public.guard_craft_catalog_version_creation()"], languages: revision ? ["sql","plpgsql"] : ["plpgsql"],
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
    ["table", craft ? "public.rework_orders" : warehouse ? "public.business_roles" : current ? "public.sourcing_case_transitions" : "public.craft_catalog_versions"],
    ["trigger", craft ? "table public.rework_orders TRIGGER" : warehouse ? "table public.business_roles TRIGGER" : current ? "table public.sourcing_factory_change_requests TRIGGER" : "table public.craft_catalog_versions TRIGGER"],
    ["schema", "schema public USAGE/CREATE/current_schema"],
    ["shadow-schema", "schema public USAGE/CREATE/current_schema"],
    ["function", proxy ? "function public.guard_rework_work_report_insert() owner" : quantity ? "function public.guard_sourcing_factory_change_request_insert() owner" : craft ? "function public.guard_rework_order_write() owner" : revision ? "function public.guard_determination_insert() owner" : warehouse ? "function public.receiving_authorized_board_operator(uuid,text) owner" : current ? "function public.guard_sourcing_contract_content_creation() owner" : "function public.guard_craft_catalog_version_creation() owner"],
    ["missing-function", proxy ? "function public.guard_rework_work_report_insert() owner" : quantity ? "function public.guard_sourcing_factory_change_request_insert() owner" : craft ? "function public.guard_rework_order_write() owner" : revision ? "function public.guard_determination_insert() owner" : warehouse ? "function public.receiving_authorized_board_operator(uuid,text) owner" : current ? "function public.guard_sourcing_contract_content_creation() owner" : "function public.guard_craft_catalog_version_creation() owner"],
    ["language", revision ? "language sql USAGE" : "language plpgsql USAGE"],
    ...(revision ? [["plpgsql", "language plpgsql USAGE"]] : []),
    ...(craft ? [["table-second","public.rework_process_configuration_items"],["trigger-second","table public.rework_process_configuration_items TRIGGER"]] : []),
  ].filter(([mode])=>!(revision || quantity || proxy) || !["table","trigger"].includes(mode!)))("rejects insufficient %s permission without writes", (mode, object) => {
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
