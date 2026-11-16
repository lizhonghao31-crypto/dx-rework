import {developmentCraftInstances,craftInstanceAggregates} from './development-craft-instance-evidence.js';
import {validateDigitalSlaSnapshot} from '@dx-rework/contracts/digital-sla';
import type { PoolClient } from "pg";
import type { SlaPlan, SlaNodeFact, SlaTime } from "@dx-rework/domain/digital-sla-plan";
import type { BusinessTime } from "@dx-rework/domain/business-clock";
import { developmentSlaPlan } from "./development-sla-enrollment.js";

type DB = Pick<PoolClient, "query">;
const iso = (value: Date | string) => new Date(value).toISOString();

/** A legacy source may have real tasks without a saved SLA model. Read their
 * current native instances, never fabricate a plan target or collapse attempts.
 * The caller has already authorized the whole source's timing evidence.
 */
export async function developmentNativeFacts(db: DB, sourceId: string, time: BusinessTime,onFutureEvidence?:(at:string)=>void): Promise<Record<string, SlaNodeFact>> {
  const rows = (await db.query(`SELECT t.task_id,t.state,t.entered_at,t.entered_quality,t.completed_at,t.completed_quality,a.task_kind,
      EXISTS(SELECT 1 FROM digital_production_task_events e WHERE e.task_id=t.task_id AND e.event_kind='material_returned') AS returned,
      EXISTS(SELECT 1 FROM digital_development_route_facts f WHERE f.task_id=t.task_id AND f.kind='尾查退回') AS rejected
    FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id)
    WHERE a.source_id=$1 AND t.route_version=coalesce((SELECT max(round_number) FROM digital_development_rounds WHERE source_id=$1),1)
    ORDER BY t.created_at,t.task_id`, [sourceId])).rows;
  return Object.fromEntries(rows.map(row => {
    const complete = row.state === 'completed' && !row.returned && !row.rejected;
    const trusted = (at: Date | string | null, quality: string) => {
      if(!at||!['现场登记','已核实'].includes(quality))return false;
      const observed=iso(at);if(Date.parse(observed)>Date.parse(time.now)){onFutureEvidence?.(observed);return false;}return true;
    };
    return [`${row.task_kind}:task:${row.task_id}`, { evidence: `task:${row.task_id}`, businessCompleted: complete,
      ...(trusted(row.entered_at, row.entered_quality) ? { startedAt: iso(row.entered_at) } : {}),
      ...(complete && trusted(row.completed_at, row.completed_quality) ? { completedAt: iso(row.completed_at) } : {}) }];
  }));
}

/** Original source/round evidence remains authoritative after conversion to a mother order.
 * This reader neither invents history nor changes P0. Correction rounds remain separate records.
 */
export async function developmentSlaEvidence(db: DB, sourceId: string, time: BusinessTime,onFutureEvidence?:(at:string)=>void,requestedRound?:number) {
  const saved = await developmentSlaPlan(db, sourceId);
  if (!saved) return null;
  if (saved.business_time.scenarioId !== time.scenarioId) throw new Error("Development/order SLA clock scope mismatch");
  const rows = (await db.query(`SELECT t.task_id,t.route_instance_id,t.route_version,t.state,t.entered_quality,t.completed_at,t.completed_quality,
      a.task_kind,d.entered_at,d.due_at,d.sla_basis,
      current_window.entered_at AS instance_entered_at,current_window.due_at AS instance_due_at,current_window.warning_at AS instance_warning_at,current_window.sla_basis AS instance_sla_basis,
      ARRAY(SELECT dependency.predecessor_id::text FROM digital_production_task_dependencies dependency WHERE dependency.task_id=t.task_id ORDER BY dependency.predecessor_id) AS predecessor_ids,
      (SELECT e.event_id FROM digital_production_task_events e WHERE e.task_id=t.task_id
        AND e.event_kind='time_corrected' ORDER BY e.recorded_at DESC,e.event_id DESC LIMIT 1) AS correction_id,
      EXISTS(SELECT 1 FROM digital_production_task_events e WHERE e.task_id=t.task_id AND e.event_kind='material_returned') AS returned,
      EXISTS(SELECT 1 FROM digital_development_route_facts f WHERE f.task_id=t.task_id AND f.kind='尾查退回') AS rejected
    FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id)
    LEFT JOIN LATERAL(SELECT r.* FROM digital_production_deadline_revisions r WHERE r.task_id=t.task_id
      ORDER BY CASE WHEN t.state='completed' AND r.reason='completion' THEN 0 ELSE 1 END,r.revision_id DESC LIMIT 1)d ON true
    LEFT JOIN LATERAL(SELECT r.entered_at,r.due_at,r.warning_at,r.sla_basis FROM digital_production_deadline_revisions r WHERE r.task_id=t.task_id ORDER BY r.revision_id DESC LIMIT 1)current_window ON true
    WHERE a.source_id=$1 ORDER BY t.route_version,t.created_at,t.task_id`, [sourceId])).rows;
  const instances=developmentCraftInstances(sourceId,rows,time,onFutureEvidence),scopedTasks=new Set(instances.map(instance=>instance.taskId));
  const facts: Record<string, SlaNodeFact> = {};
  const originalTargets: Record<string, SlaTime> = {};
  const first = rows.filter(row => row.route_version === 1);
  const businessCompleted = (row: typeof first[number]) => row.state === "completed" && !row.returned && !row.rejected;
  const accepted = (row: typeof first[number]) => row.state === "completed" && row.completed_at
    && ["现场登记", "已核实"].includes(row.completed_quality) && !row.returned && !row.rejected;
  const aliases: Record<string, string> = { development_material_recheck: "development_materials",
    development_craft_confirmation: "development_craft_return", development_external_pattern: "external_pattern" };
  for (const row of first) {
    if(scopedTasks.has(row.task_id))continue;
    const nodeId = aliases[row.task_kind] ?? row.task_kind;
    if (!saved.plan_json.nodes.some((node: { id: string }) => node.id === nodeId)) continue;
    // An inherited legacy task/policy is not proof of a captured new-model window.
    if (!row.sla_basis) continue;
    originalTargets[nodeId] = { at: row.due_at ? iso(row.due_at) : null, exclusive: false,
      reasons: row.due_at ? [] : ["原任务没有独立时限或可信起点"] };
    const fact: SlaNodeFact = { evidence: `task:${row.task_id}:round:1${row.correction_id ? `;correction:${row.correction_id}` : ""}` };
    fact.businessCompleted = businessCompleted(row);
    // Older revisions may contain a planned tail-window start as entered_at.
    // Recover the actual native return without rewriting any frozen deadline/history.
    const enteredAt = nodeId === "development_craft_return"
      ? [...first].reverse().find(candidate => ["development_printing", "development_embroidery", "development_print_embroidery"].includes(candidate.task_kind) && accepted(candidate))?.completed_at
      : row.entered_at;
    if(enteredAt){if(Date.parse(iso(enteredAt))<=Date.parse(time.now))fact.startedAt=iso(enteredAt);else onFutureEvidence?.(iso(enteredAt));}
    if(typeof row.sla_basis.warningRatio==='number')fact.standardWarningPercent=row.sla_basis.warningRatio*100;
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
  const latestRound = (await db.query(`SELECT round_number,route_nodes,inherited,published_at FROM digital_development_rounds
    WHERE source_id=$1${requestedRound!==undefined?' AND round_number=$2':''} ORDER BY round_number DESC LIMIT 1`, requestedRound!==undefined?[sourceId,requestedRound]:[sourceId])).rows[0];
  // A correction does not erase the first attempt or grant a fresh original SLA window.
  // Nodes not yet recreated on the sequential correction route must not remain "completed".
  for (const kind of (latestRound?.route_nodes ?? []) as string[]) {
    const nodeId = aliases[kind] ?? kind;
    if (!saved.plan_json.nodes.some((node: { id: string }) => node.id === nodeId)) continue;
    const current = rows.filter(row => !scopedTasks.has(row.task_id) && row.route_version === latestRound.round_number
      && (aliases[row.task_kind] ?? row.task_kind) === nodeId);
    const row = [...current].reverse().find(accepted) ?? current.at(-1);
    const fact: SlaNodeFact = { ...facts[nodeId], evidence: `development-round:${sourceId}:${latestRound.round_number}${row ? `;task:${row.task_id}` : ""}` };
    delete fact.completedAt; delete fact.completedDeadline; delete fact.waitingFor;
    fact.businessCompleted = Boolean(row && businessCompleted(row));
    if(!fact.startedAt&&row?.sla_basis&&row.entered_at&&Date.parse(iso(row.entered_at))>Date.parse(time.now))onFutureEvidence?.(iso(row.entered_at));
    if (!fact.startedAt && row?.sla_basis && row.entered_at && Date.parse(iso(row.entered_at)) <= Date.parse(time.now)) {
      fact.startedAt = iso(row.entered_at);
      if(typeof row.sla_basis.warningRatio==='number')fact.standardWarningPercent=row.sla_basis.warningRatio*100;
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
  // Scoped routes never reuse the last kind-level task or another step's return.
  const selectedRound=requestedRound??latestRound?.round_number??Math.max(1,...rows.map(row=>Number(row.route_version)));
  for(const key of new Set(instances.filter(instance=>instance.round===selectedRound).map(instance=>instance.definitionId)))delete facts[key];
  for(const key of new Set(instances.filter(instance=>instance.round===1).map(instance=>instance.definitionId)))delete originalFacts[key];
  Object.assign(facts,craftInstanceAggregates(instances,selectedRound));Object.assign(originalFacts,craftInstanceAggregates(instances,1));
  // A published correction can explicitly adopt a completed prior task rather
  // than recreate it. Restore exactly that reference, never the latest kind
  // from another round or every sibling sharing its technical kind.
  const adoptedAt=latestRound?.published_at?iso(latestRound.published_at):null;
  if(adoptedAt&&Date.parse(adoptedAt)>Date.parse(time.now))onFutureEvidence?.(adoptedAt);
  if(selectedRound>1&&adoptedAt&&Date.parse(adoptedAt)<=Date.parse(time.now))for(const [kind,reference] of Object.entries(latestRound.inherited??{})){
    const ref=reference as {taskId?:unknown;roundNumber?:unknown}|null,nodeId=aliases[kind]??kind;
    if(!ref||typeof ref.taskId!=='string'||!Number.isSafeInteger(ref.roundNumber)||Number(ref.roundNumber)>=selectedRound)continue;
    if((latestRound.route_nodes as string[]).some(key=>(aliases[key]??key)===nodeId)||instances.some(instance=>instance.round===selectedRound&&instance.definitionId===nodeId))continue;
    const own=instances.find(instance=>instance.sourceId===sourceId&&instance.taskId===ref.taskId&&instance.round===ref.roundNumber&&instance.definitionId===nodeId&&instance.eligible&&instance.fact.businessCompleted);
    if(!own)continue;
    const inherited=craftInstanceAggregates([own],own.round)[nodeId];
    if(inherited){inherited.evidence+=`;adopted:development-round:${sourceId}:${selectedRound};inherited:${own.taskId}:round:${own.round}`;facts[nodeId]=inherited;}
  }
  for(const instance of instances){
    facts[`${instance.definitionId}:task:${instance.taskId}`]=structuredClone(instance.fact);
    if(instance.round===1)originalFacts[`${instance.definitionId}:task:${instance.taskId}`]=structuredClone(instance.fact);
  }
  return { sourceId, sourceRevision: saved.revision, originalSnapshot:validateDigitalSlaSnapshot({ruleVersion:saved.rule_version,parameters:saved.parameters_json}),facts, originalFacts,instances,
    corrections: rows.filter(row => row.route_version > 1).map(row => ({ taskId: row.task_id, roundNumber: row.route_version,
      taskKind: row.task_kind, state: row.state, completedAt: accepted(row) ? iso(row.completed_at) : null })) };
}

/** A recorded external request proves applicability, without rewriting a saved plan or adding a gate. */
export function developmentEvaluationPlan(plan: SlaPlan, facts: Record<string, SlaNodeFact>): SlaPlan {
  if (!facts.external_pattern) return plan;
  return { ...plan, nodes: plan.nodes.map(node => node.id === "external_pattern" ? { ...node, applicable: "yes" } : node) };
}
