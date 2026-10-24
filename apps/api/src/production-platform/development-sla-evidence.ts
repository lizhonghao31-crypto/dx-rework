import type { PoolClient } from "pg";
import type { SlaPlan, SlaNodeFact, SlaTime } from "@dx-rework/domain/digital-sla-plan";
import type { BusinessTime } from "@dx-rework/domain/business-clock";
import { developmentSlaPlan } from "./development-sla-enrollment.js";

type DB = Pick<PoolClient, "query">;
const iso = (value: Date | string) => new Date(value).toISOString();

/** Original source/round evidence remains authoritative after conversion to a mother order.
 * This reader neither invents history nor changes P0. Correction rounds remain separate records.
 */
export async function developmentSlaEvidence(db: DB, sourceId: string, time: BusinessTime) {
  const saved = await developmentSlaPlan(db, sourceId);
  if (!saved) return null;
  if (saved.business_time.scenarioId !== time.scenarioId) throw new Error("Development/order SLA clock scope mismatch");
  const rows = (await db.query(`SELECT t.task_id,t.route_version,t.state,t.completed_at,t.completed_quality,
      a.task_kind,d.entered_at,d.due_at,d.sla_basis,
      (SELECT e.event_id FROM digital_production_task_events e WHERE e.task_id=t.task_id
        AND e.event_kind='time_corrected' ORDER BY e.recorded_at DESC,e.event_id DESC LIMIT 1) AS correction_id,
      EXISTS(SELECT 1 FROM digital_production_task_events e WHERE e.task_id=t.task_id AND e.event_kind='material_returned') AS returned,
      EXISTS(SELECT 1 FROM digital_development_route_facts f WHERE f.task_id=t.task_id AND f.kind='尾查退回') AS rejected
    FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id)
    LEFT JOIN LATERAL(SELECT r.* FROM digital_production_deadline_revisions r WHERE r.task_id=t.task_id
      ORDER BY CASE WHEN t.state='completed' AND r.reason='completion' THEN 0 ELSE 1 END,r.revision_id DESC LIMIT 1)d ON true
    WHERE a.source_id=$1 ORDER BY t.route_version,t.created_at,t.task_id`, [sourceId])).rows;
  const facts: Record<string, SlaNodeFact> = {};
  const originalTargets: Record<string, SlaTime> = {};
  const first = rows.filter(row => row.route_version === 1);
  const businessCompleted = (row: typeof first[number]) => row.state === "completed" && !row.returned && !row.rejected;
  const accepted = (row: typeof first[number]) => row.state === "completed" && row.completed_at
    && ["现场登记", "已核实"].includes(row.completed_quality) && !row.returned && !row.rejected;
  const aliases: Record<string, string> = { development_material_recheck: "development_materials",
    development_craft_confirmation: "development_craft_return", development_external_pattern: "external_pattern" };
  for (const row of first) {
    const nodeId = aliases[row.task_kind] ?? row.task_kind;
    if (!saved.plan_json.nodes.some((node: { id: string }) => node.id === nodeId)) continue;
    // An inherited legacy task/policy is not proof of a captured new-model window.
    if (!row.sla_basis) continue;
    originalTargets[nodeId] = { at: row.due_at ? iso(row.due_at) : null, exclusive: false,
      reasons: row.due_at ? [] : ["原任务没有独立时限或可信起点"] };
    const fact: SlaNodeFact = { evidence: `task:${row.task_id}:round:1${row.correction_id ? `;correction:${row.correction_id}` : ""}` };
    fact.businessCompleted = businessCompleted(row);
    if (row.entered_at && Date.parse(iso(row.entered_at)) <= Date.parse(time.now)) fact.startedAt = iso(row.entered_at);
    if (row.sla_basis.seconds !== null) fact.standardMinutes = row.sla_basis.seconds / 60;
    if (accepted(row)) {
      fact.completedAt = iso(row.completed_at);
      fact.completedDeadline = { at: row.due_at ? iso(row.due_at) : null, exclusive: false,
        reasons: row.due_at ? [] : ["原任务没有独立时限或可信起点"] };
    } else if (row.state === "completed" && !row.completed_at) {
      // Business completion remains valid. The evaluator separately marks its timing unrated.
    } else if (row.returned || row.rejected || row.state === "blocked" || row.state === "cancelled") {
      fact.waitingFor = { reason: row.rejected ? "尾查退回，沿原纠正流程办理" : row.returned ? "资料退回，待原核配流程处理" : row.state === "cancelled" ? "原任务已取消，不能当作完成" : "原任务前置条件尚未满足", source: fact.evidence };
    }
    // A later successful recheck completes the same responsibility window without resetting its start.
    if (nodeId === "external_pattern" || !facts[nodeId]?.completedAt || fact.completedAt) facts[nodeId] = fact;
  }
  const originalFacts = structuredClone(facts);
  const latestRound = (await db.query(`SELECT round_number,route_nodes FROM digital_development_rounds
    WHERE source_id=$1 ORDER BY round_number DESC LIMIT 1`, [sourceId])).rows[0];
  // A correction does not erase the first attempt or grant a fresh original SLA window.
  // Nodes not yet recreated on the sequential correction route must not remain "completed".
  for (const kind of (latestRound?.route_nodes ?? []) as string[]) {
    const nodeId = aliases[kind] ?? kind;
    if (!saved.plan_json.nodes.some((node: { id: string }) => node.id === nodeId)) continue;
    const current = rows.filter(row => row.route_version === latestRound.round_number
      && (aliases[row.task_kind] ?? row.task_kind) === nodeId);
    const row = [...current].reverse().find(accepted) ?? current.at(-1);
    const fact: SlaNodeFact = { ...facts[nodeId], evidence: `development-round:${sourceId}:${latestRound.round_number}${row ? `;task:${row.task_id}` : ""}` };
    delete fact.completedAt; delete fact.completedDeadline; delete fact.waitingFor;
    fact.businessCompleted = Boolean(row && businessCompleted(row));
    if (!fact.startedAt && row?.sla_basis && row.entered_at && Date.parse(iso(row.entered_at)) <= Date.parse(time.now)) {
      fact.startedAt = iso(row.entered_at);
      if (row.sla_basis.seconds !== null) fact.standardMinutes = row.sla_basis.seconds / 60;
    }
    if (row && accepted(row) && row.sla_basis) {
      fact.completedAt = iso(row.completed_at);
      fact.completedDeadline = originalTargets[nodeId] ?? { at: row.due_at ? iso(row.due_at) : null,
        exclusive: false, reasons: row.due_at ? [] : ["本轮没有可信截止点"] };
    } else fact.waitingFor = { reason: `第${latestRound.round_number}轮${row?.state === "cancelled" ? "已取消，不能当作完成" : "纠正尚未有效完成"}`, source: fact.evidence };
    facts[nodeId] = fact;
  }
  // 工艺回收确认 is inside the parent window: its completion closes that window,
  // not the earlier processing report. The original processing task remains visible in history.
  for (const nodeId of ["development_printing", "development_embroidery", "development_print_embroidery"]) {
    const parent = facts[nodeId];
    if (!parent) continue;
    const receipt = facts.development_craft_return;
    delete parent.completedAt;
    parent.businessCompleted = Boolean(receipt?.businessCompleted || receipt?.completedAt);
    if (receipt?.completedAt) { parent.completedAt = receipt.completedAt; parent.evidence += `;${receipt.evidence}`; }
    else { delete parent.completedDeadline; parent.waitingFor = { reason: "工艺回收尚未确认", source: parent.evidence }; }
  }
  return { sourceId, sourceRevision: saved.revision, facts, originalFacts,
    corrections: rows.filter(row => row.route_version > 1).map(row => ({ taskId: row.task_id, roundNumber: row.route_version,
      taskKind: row.task_kind, state: row.state, completedAt: accepted(row) ? iso(row.completed_at) : null })) };
}

/** A recorded external request proves applicability, without rewriting a saved plan or adding a gate. */
export function developmentEvaluationPlan(plan: SlaPlan, facts: Record<string, SlaNodeFact>): SlaPlan {
  if (!facts.external_pattern) return plan;
  return { ...plan, nodes: plan.nodes.map(node => node.id === "external_pattern" ? { ...node, applicable: "yes" } : node) };
}
