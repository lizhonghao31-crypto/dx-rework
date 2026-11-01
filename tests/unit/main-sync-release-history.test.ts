import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkHistory } from "../../scripts/deploy/acceptance-update-policy.mjs";
import { assertMigrationSequence } from "../../scripts/migration-history-policy.mjs";
import { hasRequiredWarehouseRole } from "@dx-rework/contracts";

const manifest = JSON.parse(readFileSync("apps/api/src/platform/migration-manifest.json", "utf8"));
const branches = JSON.parse(readFileSync("scripts/migration-branches.json", "utf8"));
const extensions = JSON.parse(readFileSync("scripts/migration-main-extensions.json", "utf8"));
const frozenMain225Extensions = extensions.filter((row: {version:string})=>Number(row.version.slice(0,4))<=225);
const newlyReconciledMain = ["0226_external_revision_preserve_handler", "0227_qc_other_craft", "0228_sourcing_contract_return_cycles", "0229_sourcing_price_reapplications", "0230_sourcing_factory_change_current_quantity", "0231_temporary_special_process_proxy_reporting", "0232_pmc_readonly_role"];
const production = [...manifest.migrations.slice(0, 217), ...branches.main, ...frozenMain225Extensions].sort((a, b) => a.version.localeCompare(b.version));
const added = ["0225_warehouse_supervisor_cutting_read", "0242_warehouse_supervisor_digital_dispatch", "0243_misc_order_stable_association", "0244_development_sewing_result_attachments", "0245_development_pattern_result_attachments", "0246_development_round_arrangements", "0247_development_material_verification"];
const acceptance = manifest.migrations.filter((row: { version: string }) => Number(row.version.slice(0,4))<=247 && !added.includes(row.version) && !newlyReconciledMain.includes(row.version));

describe("main 0225 and Acceptance 248 compatible sync", () => {
  it("admits both exact histories without rewriting applied rows", () => {
    expect(production).toHaveLength(225);
    expect(acceptance).toHaveLength(248);
    // This is the frozen old Acceptance sample, not the current target manifest.
    expect(acceptance.some((row:{version:string})=>row.version==='0230_sourcing_factory_change_current_quantity')).toBe(false);
    expect(acceptance.some((row:{version:string})=>row.version==='0231_temporary_special_process_proxy_reporting')).toBe(false);
    expect(acceptance.some((row:{version:string})=>row.version==='0232_pmc_readonly_role')).toBe(false);
    expect(manifest.migrations.find((row:{version:string})=>row.version==='0231_temporary_special_process_proxy_reporting')).toEqual({version:'0231_temporary_special_process_proxy_reporting',checksum:'39a9c918c6589c9905ab0cf32de1f7cc304119fd4840a3fa8da34ddfb3e3d6b4'});
    expect(manifest.migrations.find((row:{version:string})=>row.version==='0230_sourcing_factory_change_current_quantity')).toEqual({version:'0230_sourcing_factory_change_current_quantity',checksum:'4091340fdb842e866aec8b9f124c73c9d5e7086bd122677c144864355052e6bf'});
    expect(checkHistory({ database: "dx_rework", migrations: production }, manifest, "production").pending).toHaveLength(manifest.migrations.length-production.length);
    expect(checkHistory({ database: "dx_rework_acceptance", migrations: acceptance }, manifest, "acceptance").pending).toEqual(manifest.migrations.filter((row:{version:string})=>!acceptance.some((old:{version:string})=>old.version===row.version)).map((row:{version:string})=>row.version));
    expect(frozenMain225Extensions.at(-1)).toEqual({ version: added[0], checksum: "85ce0adb63cdba755011a53455bd9f7c762d9e5f0d5dd0157111c375b1d0d4b1" });
    expect(() => assertMigrationSequence(manifest.migrations)).not.toThrow();
    expect(() => assertMigrationSequence([...manifest.migrations, { version: "0225_unknown", checksum: "0".repeat(64) }].sort((a, b) => a.version.localeCompare(b.version)))).toThrow();
    expect(() => checkHistory({ database: "dx_rework", migrations: production.map(row => row.version === added[0] ? { ...row, checksum: "0".repeat(64) } : row) }, manifest, "production")).toThrow("drift");
  });
  it("matches only warehouse task families and retains actual independent cutting roles", () => {
    expect(hasRequiredWarehouseRole(["warehouse_supervisor"], "warehouse_receiver")).toBe(true);
    expect(hasRequiredWarehouseRole(["warehouse_supervisor"], "cutting_worker")).toBe(false);
    expect(hasRequiredWarehouseRole(["warehouse_supervisor", "cutting_worker"], "cutting_worker")).toBe(true);
    expect(hasRequiredWarehouseRole(["order_merchandiser"], "warehouse_receiver")).toBe(false);
  });
});
