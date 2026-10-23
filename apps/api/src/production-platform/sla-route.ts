import { DIGITAL_SLA_PARAMETERS, validateDigitalSlaSnapshot, type DigitalSlaSnapshot } from "@dx-rework/contracts/digital-sla";
import { orderedSlaNodes, type SlaAnchor, type SlaPlan, type SlaPlanNode } from "@dx-rework/domain/digital-sla-plan";

export type SlaRouteSelection = {
  developmentCraft: "none" | "printing" | "embroidery" | "print_embroidery" | "unknown";
  washing: "yes" | "no" | "unknown";
  bulkCraft: "none" | "printing" | "embroidery" | "print_embroidery" | "unknown";
};
const crafts = ["printing", "embroidery", "print_embroidery"] as const;
const applies = (choice: string, expected: string): SlaPlanNode["applicable"] => choice === "unknown" ? "unknown" : choice === expected ? "yes" : "no";
/** Complete structural plan at creation. These dependencies calculate dates; they do not authorize work. */
export function buildOrderSlaRoute(snapshot: DigitalSlaSnapshot, selection: SlaRouteSelection,
  anchors: Record<string, SlaAnchor>, poIds: readonly string[]): SlaPlan {
  validateDigitalSlaSnapshot(snapshot);
  if (!poIds.length || new Set(poIds).size !== poIds.length) throw new Error("SLA requires unique PO identities");
  const rows = DIGITAL_SLA_PARAMETERS.filter(p => p.stage > 0);
  const nodes: SlaPlanNode[] = [];
  const add = (key: string, options: Partial<SlaPlanNode> = {}, suffix = "") => {
    const row = rows.find(p => p.key === key)!;
    const v = snapshot.parameters[key]!.value;
    if (v.kind === "ratio" || v.kind === "buffer") throw new Error("Global policy is not a business node");
    const n: SlaPlanNode = { id: key + suffix, parameterKey: key, label: row.label, stage: row.stage,
      kind: v.kind, minutes: "minutes" in v ? v.minutes : null, offsetDays: "days" in v ? v.days : null,
      applicable: "yes", countsProgress: v.kind !== "offset", dependsOn: [], anchorKey: row.startsAt,
      targetKey: null, includedIn: null, includedPosition: "start", ...options };
    nodes.push(n); return n;
  };
  const after = (key: string, deps: string[], options: Partial<SlaPlanNode> = {}) => add(key, { anchorKey: null, dependsOn: deps, ...options });
  add("order_creation"); add("customer_confirmation");
  add("development_materials");
  after("development_pattern", ["development_materials"]);
  add("external_pattern", { applicable: anchors.external_pattern_requested ? "yes" : "unknown" });
  after("development_cutting", ["development_pattern"]);
  for (const craft of crafts) after(`development_${craft}`, ["development_cutting"], { applicable: applies(selection.developmentCraft, craft) });
  const developmentParent = selection.developmentCraft === "unknown" || selection.developmentCraft === "none" ? "development_printing" : `development_${selection.developmentCraft}`;
  const hasCraft = selection.developmentCraft === "unknown" ? "unknown" : selection.developmentCraft === "none" ? "no" : "yes";
  add("development_craft_dispatch", { includedIn: developmentParent, anchorKey: null, applicable: hasCraft });
  add("development_craft_return", { includedIn: developmentParent, anchorKey: null, includedPosition: "end", applicable: hasCraft });
  const craftEnds = selection.developmentCraft === "unknown" ? crafts.map(c => `development_${c}`) : selection.developmentCraft === "none" ? ["development_cutting"] : [developmentParent];
  after("development_sewing", craftEnds);
  add("development_sewing_transfer", { includedIn: "development_sewing", anchorKey: null });
  after("development_pre_wash_check", ["development_sewing"], { applicable: applies(selection.washing, "yes") });
  after("development_washing", ["development_pre_wash_check"], { applicable: applies(selection.washing, "yes") });
  add("development_washing_dispatch", { includedIn: "development_washing", anchorKey: null, applicable: applies(selection.washing, "yes") });
  after("development_tail_check", [selection.washing === "no" ? "development_sewing" : "development_washing"]);
  add("development_accessories"); add("development_shipping"); add("budget");
  // Technical, commercial and fabric paths start independently. No pricing dependency on pattern making.
  add("production_sheet"); after("bulk_pattern", ["production_sheet"]);
  add("sourcing_ie"); after("sourcing_selection", ["sourcing_ie"]); after("sourcing_approval", ["sourcing_selection"]);
  add("fabric_inspection", { anchorKey: "expected_fabric_arrival" });
  after("warehouse_preshrink", ["fabric_inspection"]);
  // Planned handoff can be calculated. It is never materialized as actual C.
  after("bulk_cutting", ["warehouse_preshrink", "bulk_pattern"]);
  for (const craft of crafts) after(`bulk_${craft}`, ["bulk_cutting"], { applicable: applies(selection.bulkCraft, craft) });
  const bulkEnds = selection.bulkCraft === "unknown" ? crafts.map(c => `bulk_${c}`) : selection.bulkCraft === "none" ? ["bulk_cutting"] : [`bulk_${selection.bulkCraft}`];
  after("bulk_qc", bulkEnds, { applicable: selection.bulkCraft === "unknown" ? "unknown" : selection.bulkCraft === "none" ? "no" : "yes" });
  after("warehouse_dispatch", [...(selection.bulkCraft === "none" ? ["bulk_cutting"] : ["bulk_qc"]), "sourcing_approval"]);
  add("warehouse_accessories");
  for (const poId of poIds) {
    const suffix = `:${poId}`;
    add("factory_production", { targetKey: `factory_delivery_date${suffix}`, anchorKey: null, dependsOn: ["warehouse_dispatch"] }, suffix);
    // Ship sample is deliberately not a predecessor of factory production, returns, QC or packing.
    add("ship_sample", {}, suffix);
    add("ship_sample_advance", { anchorKey: null, targetKey: `customer_shipping_date${suffix}` }, suffix);
    add("order_shipping_reminder", { anchorKey: null, targetKey: `customer_shipping_date${suffix}` }, suffix);
    add("return_logistics", { anchorKey: `planned_factory_return_dispatch${suffix}` }, suffix);
    add("garment_inspection", { anchorKey: null, dependsOn: [`return_logistics${suffix}`] }, suffix);
    add("garment_rework", { applicable: "no" }, suffix);
    add("garment_packing", { anchorKey: null, dependsOn: [`garment_inspection${suffix}`] }, suffix);
  }
  add("receiving_span");
  const warning = snapshot.parameters.warning_ratio!.value;
  const buffer = snapshot.parameters.stage_buffer!.value;
  if (warning.kind !== "ratio" || buffer.kind !== "buffer") throw new Error("Invalid SLA warning/buffer policy");
  const plan = { nodes, anchors: structuredClone(anchors), warningPercent: warning.percent, stageBufferMinutes: buffer.minutes };
  orderedSlaNodes(plan);
  return plan;
}
