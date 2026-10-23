import { describe, expect, it } from "vitest";
import { DIGITAL_SLA_PARAMETERS, DigitalSlaFactSchema, digitalSlaDefaults, resolveDigitalSlaSnapshot, validateDigitalSlaValues, validateDigitalSlaSnapshot } from "../../packages/contracts/src/digital-sla.js";

describe("confirmed SLA configuration contract", () => {
  it("has unique complete defaults and preserves the 201h development path", () => {
    const values = validateDigitalSlaValues(digitalSlaDefaults());
    expect(new Set(DIGITAL_SLA_PARAMETERS.map(row => row.key)).size).toBe(DIGITAL_SLA_PARAMETERS.length);
    const path = ["development_materials", "development_pattern", "development_cutting", "development_printing", "development_sewing", "development_pre_wash_check", "development_washing", "development_tail_check"];
    const minutes = path.reduce((sum, key) => {
      const v = values[key]!;
      if (v.kind !== "duration") throw new Error("Unexpected path kind");
      return sum + v.minutes;
    }, 0);
    expect(minutes / 60).toBe(201);
    expect(values.warning_ratio).toEqual({ kind: "ratio", percent: 70 });
    expect(values.stage_buffer).toEqual({ kind: "buffer", minutes: 0 });
    expect(values.budget).toEqual({ kind: "unlimited" });
    expect(values.warehouse_accessories).toEqual({ kind: "unlimited" });
    expect(values.return_logistics?.kind).toBe("estimate");
  });
  it.each([
    ["development_pattern", { kind: "duration", minutes: -1 }],
    ["development_pattern", { kind: "duration", minutes: 0 }],
    ["development_pattern", { kind: "duration", hours: 48 }],
    ["development_pattern", { kind: "unlimited" }],
    ["warning_ratio", { kind: "ratio", percent: 100 }],
    ["warning_ratio", { kind: "ratio", percent: 0.7 }],
    ["ship_sample_advance", { kind: "offset", days: -10 }],
    ["return_logistics", { kind: "duration", minutes: 2880 }],
    ["budget", { kind: "duration", minutes: 60 }],
  ])("rejects invalid type/value for %s", (key, value) => {
    expect(() => validateDigitalSlaValues({ ...digitalSlaDefaults(), [key as string]: value })).toThrow();
  });
  it("rejects missing/unknown keys and both included targets exceeding a shared craft window", () => {
    const values = digitalSlaDefaults();
    delete values.bulk_cutting;
    expect(() => validateDigitalSlaValues(values)).toThrow();
    expect(() => validateDigitalSlaValues({ ...digitalSlaDefaults(), new_gate: { kind: "unlimited" } })).toThrow();
    expect(() => validateDigitalSlaValues({ ...digitalSlaDefaults(), development_printing: { kind: "duration", minutes: 45 } })).toThrow(/Included/);
    expect(() => validateDigitalSlaValues({ ...digitalSlaDefaults(), development_sewing: { kind: "duration", minutes: 20 } })).toThrow(/Included/);
    expect(() => validateDigitalSlaValues({ ...digitalSlaDefaults(), development_printing: { kind: "duration", minutes: 60 } })).not.toThrow();
  });
  it("resolves each parameter order > existing customer > global without later drift", () => {
    const global = { version: 2, values: digitalSlaDefaults() };
    const snapshot = resolveDigitalSlaSnapshot(global,
      { version: 3, values: { development_pattern: { kind: "duration", minutes: 3000 }, production_sheet: { kind: "duration", minutes: 4500 } } },
      { version: 4, values: { development_pattern: { kind: "duration", minutes: 3600 } } });
    expect(snapshot.parameters.development_pattern).toEqual({ value: { kind: "duration", minutes: 3600 }, source: "order", sourceVersion: 4 });
    expect(snapshot.parameters.production_sheet?.source).toBe("customer");
    expect(snapshot.parameters.bulk_cutting?.source).toBe("global");
    global.values.bulk_cutting = { kind: "duration", minutes: 4000 };
    expect(snapshot.parameters.bulk_cutting?.value).toEqual({ kind: "duration", minutes: 1440 });
    expect(() => validateDigitalSlaSnapshot({ ...snapshot, ruleVersion: "unapproved" })).toThrow();
    expect(() => resolveDigitalSlaSnapshot(global, { version: 1, values: { unexpected: { kind: "unlimited" } } })).toThrow();
  });
  it("preserves unknown/date precision and never supplies an actual receipt time", () => {
    const base = { eventId: "00000000-0000-4000-8000-000000000001", actorId: "00000000-0000-4000-8000-000000000002", orderId: "00000000-0000-4000-8000-000000000003", poId: null, batchId: null, occurrence: 1, sourceRecordId: "original-id", sourceVersion: 1, eventKind: "cutting_fabric_actually_received", recordedAt: "2026-10-23T12:00:00+08:00", correctsEventId: null };
    expect(DigitalSlaFactSchema.parse({ ...base, time: { precision: "unknown", reason: "原记录无可信实际收布时刻" } }).time).toEqual({ precision: "unknown", reason: "原记录无可信实际收布时刻" });
    expect(DigitalSlaFactSchema.safeParse({ ...base, time: { precision: "instant", value: "2026-10-23" } }).success).toBe(false);
    expect(DigitalSlaFactSchema.safeParse({ ...base, time: { precision: "date", value: "2026-02-30" } }).success).toBe(false);
  });
});
