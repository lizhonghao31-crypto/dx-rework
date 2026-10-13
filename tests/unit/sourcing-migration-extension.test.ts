import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assertAppliedMigrationHistory, assertMigrationSequence } from "../../scripts/migration-history-policy.mjs";

type Entry={version:string;checksum:string};
const main:Entry[]=JSON.parse(readFileSync("apps/api/src/platform/migration-manifest.json","utf8")).migrations;
const branches:{main:Entry[];digital:Entry[]}=JSON.parse(readFileSync("scripts/migration-branches.json","utf8"));
const extension:Entry[]=JSON.parse(readFileSync("scripts/migration-main-extensions.json","utf8"));
const common=main.slice(0,217);
const historicalMain=main.filter(row=>Number(row.version.slice(0,4))<=223);
const sorted=(rows:Entry[])=>[...rows].sort((a,b)=>a.version.localeCompare(b.version));
const markers=[{version:"0232_reconcile_contract_and_digital_histories",checksum:"a".repeat(64)},
  {version:"0233_manual_contract_template_provenance",checksum:"b".repeat(64)}];
const release=sorted([...common,...branches.main,...branches.digital,...markers]);
const merged=sorted([...release,...extension]);

describe("explicit main extension alongside the existing release migration identity",()=>{
  it("keeps main strictly contiguous and rejects history drift",()=>{
    expect(()=>assertMigrationSequence(main)).not.toThrow();
    expect(()=>assertAppliedMigrationHistory(main,main)).not.toThrow();
    expect(()=>assertAppliedMigrationHistory(main.map((r,i)=>i===220?{...r,checksum:"0".repeat(64)}:r),main)).toThrow("checksum drift");
    expect(()=>assertMigrationSequence(main.filter(r=>!r.version.startsWith("0210_")))).toThrow("sequence gap");
  });
  it("accepts both complete histories and releases upgraded before the new main extension",()=>{
    for(const applied of [historicalMain,release,merged])expect(()=>assertAppliedMigrationHistory(applied,merged)).not.toThrow();
    // New main migrations remain a separate prefix until explicitly reconciled.
    expect(()=>assertAppliedMigrationHistory(main,merged)).toThrow("absent from Head manifest");
    expect(()=>assertMigrationSequence(merged)).not.toThrow();
    expect(merged.filter(r=>r.version.startsWith("0221_"))).toHaveLength(2);
    expect(merged.filter(r=>r.version.startsWith("0222_"))).toHaveLength(2);
    expect(merged.filter(r=>r.version.startsWith("0223_"))).toHaveLength(2);
  });
  it("preserves every resumable lane prefix while rejecting holes and unknown collisions",()=>{
    for(let m=0;m<=branches.main.length+extension.length;m++)for(let d=0;d<=branches.digital.length;d++){
      const applied=sorted([...common,...[...branches.main,...extension].slice(0,m),...branches.digital.slice(0,d)]);
      const frozen=JSON.stringify(applied);expect(()=>assertAppliedMigrationHistory(applied,merged)).not.toThrow();
      expect(JSON.stringify(applied)).toBe(frozen);
    }
    expect(()=>assertAppliedMigrationHistory(sorted([...common,...extension]),merged)).toThrow();
    expect(()=>assertAppliedMigrationHistory(sorted([...common,...branches.main,...markers]),merged)).toThrow("both complete");
    expect(()=>assertMigrationSequence(sorted([...merged,{version:"0221_unapproved",checksum:"0".repeat(64)}]))).toThrow();
    expect(()=>assertMigrationSequence(merged.map(r=>r.version===extension[0]!.version?{...r,checksum:"0".repeat(64)}:r))).toThrow("checksum drift");
    expect(()=>assertMigrationSequence(sorted([...merged,{version:"0223_unapproved",checksum:"0".repeat(64)}]))).toThrow();
    expect(()=>assertAppliedMigrationHistory(sorted([...merged,{version:"0223_unapproved",checksum:"0".repeat(64)}]),merged)).toThrow();
    expect(()=>assertMigrationSequence(merged.map(r=>r.version===extension.at(-1)!.version?{...r,checksum:"0".repeat(64)}:r))).toThrow("checksum drift");
    expect(()=>assertAppliedMigrationHistory([...merged,extension[0]!],merged)).toThrow("Duplicate");
  });
});
