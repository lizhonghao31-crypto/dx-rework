import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkHistory } from "../../scripts/deploy/acceptance-update-policy.mjs";
import { assertMigrationSequence } from "../../scripts/migration-history-policy.mjs";
import { hasRequiredWarehouseRole } from "@dx-rework/contracts";

const manifest = JSON.parse(readFileSync("apps/api/src/platform/migration-manifest.json", "utf8"));
const branches = JSON.parse(readFileSync("scripts/migration-branches.json", "utf8"));
const extensions = JSON.parse(readFileSync("scripts/migration-main-extensions.json", "utf8"));
const frozenMain225Extensions = extensions.filter((row: {version:string})=>Number(row.version.slice(0,4))<=225);
const newlyReconciledMain = ["0226_external_revision_preserve_handler", "0227_qc_other_craft"];
const production = [...manifest.migrations.slice(0, 217), ...branches.main, ...frozenMain225Extensions].sort((a, b) => a.version.localeCompare(b.version));
const added = ["0225_warehouse_supervisor_cutting_read", "0242_warehouse_supervisor_digital_dispatch", "0243_misc_order_stable_association", "0244_development_sewing_result_attachments", "0245_development_pattern_result_attachments"];
const acceptance = manifest.migrations.filter((row: { version: string }) => !added.includes(row.version) && !newlyReconciledMain.includes(row.version));

describe("main 0225 and Acceptance 248 compatible sync", () => {
  it("admits both exact histories without rewriting applied rows", () => {
    expect(production).toHaveLength(225);
    expect(acceptance).toHaveLength(248);
    expect(checkHistory({ database: "dx_rework", migrations: production }, manifest, "production").pending).toHaveLength(30);
    expect(checkHistory({ database: "dx_rework_acceptance", migrations: acceptance }, manifest, "acceptance").pending).toEqual([...added,...newlyReconciledMain].sort((a,b)=>a.localeCompare(b)));
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
