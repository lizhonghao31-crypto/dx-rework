import {
  JOURNEY_NODES, JOURNEY_STAGES, isJourneyPlanningNode,
  type JourneyBusinessProgress, type JourneyBusinessRequirement, type JourneyBusinessQuantities,
  type JourneyNode, type JourneyRequirementTarget, type OrderJourney,
} from '@dx-rework/contracts/digital-production-journey';
import type {OrderClosureSheet} from '@dx-rework/contracts/order-closure';
import {journeyCompletedAtObservation} from './journey-completion-evidence.js';

const keyOf = (key: string) => key === 'development_material_recheck' ? 'development_materials' : key;
export type AdoptedRequirementPlan = {
  planId: string; revision: number;
  targets: ReadonlyMap<string, readonly JourneyRequirementTarget[]>;
};
export type RequirementEvidence = Map<string, {completed: boolean; applicability: 'applicable' | 'not_applicable' | 'unknown'; reason: string; instanceIds: string[]}>;
export type RequirementReplacement = {retiredId: string; successorId: string};

/** One requirement per business kind, covering every required execution instance.
 * The catalog supplies missing obligations, not the number of returned batches.
 * Retiring an instance never cancels the requirement: a missing replacement is unknown.
 */
export function journeyBusinessProgress(order: OrderJourney, asOf: string,
  plan: AdoptedRequirementPlan | null | 'unavailable' = null,
  quantities?: JourneyBusinessQuantities, evidence: RequirementEvidence = new Map(), replacements: readonly RequirementReplacement[] = []): JourneyBusinessProgress {
  const allNodes = order.stages.flatMap(stage => stage.nodes).filter(node => !isJourneyPlanningNode(node));
  const nodes = allNodes.filter(node => node.current);
  const definitions = JOURNEY_NODES.filter(node => !node.planningOnly
    && (order.orderId || node.stage === 'development')
    && (node.stage !== 'creation' || node.key === 'order_information'));
  const keys = new Map(definitions.map(definition => [keyOf(definition.key), definition]));
  for (const node of nodes) if ((order.orderId || node.stage === 'development')
    && (node.stage !== 'creation' || node.key === 'order_information') && !keys.has(keyOf(node.key))) keys.set(keyOf(node.key), {...node, count: false});
  const requirements: JourneyBusinessRequirement[] = [...keys].map(([key, definition]) => {
    const instances = nodes.filter(node => keyOf(node.key) === key);
    const applicable = instances.filter(node => node.state !== 'not_applicable' && node.progressApplicability !== 'not_applicable');
    const reachesCurrent = (id: string, seen = new Set<string>()): boolean => {
      if (seen.has(id)) return false;
      if (applicable.some(node => node.instanceId === id)) return true;
      const visited = new Set(seen).add(id);
      return replacements.filter(link => link.retiredId === id).some(link => reachesCurrent(link.successorId, visited));
    };
    const unresolvedRetired = applicable.length ? allNodes.filter(node => keyOf(node.key) === key && !node.current
      && node.round === order.adoptedRound && node.state !== 'not_applicable' && node.progressApplicability !== 'not_applicable'
      && !instances.some(current => current.inheritedFrom?.taskId === node.instanceId) && !reachesCurrent(node.instanceId)) : [];
    const unknown = !instances.length || unresolvedRetired.length > 0 || applicable.some(node => node.state === 'unavailable' || node.progressApplicability === 'unknown');
    const applicability = unknown ? 'unknown' : applicable.length ? 'applicable' : 'not_applicable';
    const reasons = !instances.length ? [`尚未取得${definition.label}的适用要求及承接记录`]
      : unknown ? [`${definition.label}的适用范围或读取依据尚未齐全`] : [];
    reasons.push(...unresolvedRetired.map(node => `${node.subject ?? node.label}退役后的有效承接范围尚未核实`));
    if (!unknown) reasons.push(...applicable.filter(node => !journeyCompletedAtObservation(node,asOf) && node.subject).map(node => `尚待${node.subject}完成`));
    const fact = evidence.get(key);
    const isCompleted = applicability === 'applicable' && applicable.every(node=>journeyCompletedAtObservation(node,asOf));
    return {id: `${key}:whole`, key, label: definition.label, stage: definition.stage, scopeRef: 'whole',
      applicability: fact?.applicability ?? applicability, completed: fact ? fact.applicability === 'applicable' && fact.completed : isCompleted,
      instanceIds: fact?.instanceIds ?? applicable.map(node => node.instanceId).sort(), reasons: fact ? [fact.reason] : reasons,
      targets: plan && plan !== 'unavailable' ? [...(plan.targets.get(key) ?? [])] : []};
  });
  // Quantity completion and quality coverage remain independent even after closure.
  const quality = requirements.find(requirement => requirement.key === 'receiving_inspection');
  if (quality && quantities?.lines.some(line => line.qualityGap === null)) {
    quality.applicability = 'unknown'; quality.completed = false;
    quality.reasons.push('尚未取得全部有效实收范围的到仓质检覆盖依据');
  }
  if (quality && quantities?.lines.some(line => line.qualityGap !== null && line.qualityGap > 0)) {
    quality.applicability = 'applicable'; quality.completed = false;
    quality.reasons.push(...quantities.lines.filter(line => line.qualityGap !== null && line.qualityGap > 0)
      .map(line => `对应PO有效实收${line.received}件，到仓质检覆盖${line.inspected}件，仍缺${line.qualityGap}件`));
  }
  if (quality && quantities?.lines.some(line => line.qualityConflict)) {
    quality.applicability = 'applicable'; quality.completed = false;
    quality.reasons.push('原质检覆盖与当前有效实收范围不一致，不能认定全部质量要求已完成');
  }
  const summarize = (rows: JourneyBusinessRequirement[]) => {
    const applicable = rows.filter(row => row.applicability === 'applicable').length;
    const done = rows.filter(row => row.applicability === 'applicable' && row.completed).length;
    const unknown = rows.filter(row => row.applicability === 'unknown').length;
    return {applicable, completed: done, unknown, ratio: unknown || !applicable ? null : done / applicable};
  };
  const required = requirements.filter(row => row.applicability !== 'not_applicable');
  // A requirement is covered only when all its selected, adopted scope targets exist.
  const covered = required.filter(row => row.applicability === 'applicable' && row.targets.length > 0);
  const day = new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'}).format(new Date(asOf));
  const due = covered.filter(row => row.targets.every(target => target.precision === 'date'
    ? target.at < day : Date.parse(target.at) <= Date.parse(asOf)));
  const missing = required.length - covered.length;
  return {ruleVersion: 'journey-business-v1', asOf, requirements, ...summarize(requirements),
    stages: JOURNEY_STAGES.map(stage => ({key: stage.key, ...summarize(requirements.filter(row => row.stage === stage.key))})),
    plan: {status: plan === 'unavailable' ? 'unavailable' : !plan ? 'not_adopted' : missing ? 'partial' : 'complete',
      planId: plan && plan !== 'unavailable' ? plan.planId : null, revision: plan && plan !== 'unavailable' ? plan.revision : null,
      covered: covered.length, missing, due: due.length, outstandingDue: due.filter(row => !row.completed).map(row => row.id),
      reasons: plan === 'unavailable' ? ['当前权限范围未包含本单已采用计划'] : !plan ? ['本单尚未取得已采用的系列计划']
        : missing ? [`另${missing}项业务要求尚无完整对应的已采用计划日期`] : []},
    ...(quantities ? {quantities} : {})};
}

/** Consume the effective cumulative receipt, not a sum of receipts plus corrections.
 * This is a read model only; it does not change the original quality/closure guards.
 */
export function journeyBusinessQuantities(closure: OrderClosureSheet, attributedReceiptIds: ReadonlySet<string> = new Set()): JourneyBusinessQuantities {
  const lines:JourneyBusinessQuantities['lines'] = closure.lines.map(line => {
    const checks = [...new Map((closure.quality ?? []).filter(check => check.lineId === line.lineId).map(check => [check.receiptId, check])).values()];
    const inspected = checks.filter(check => check.inspected).reduce((sum, check) => sum + check.quantity, 0);
    const qualified = checks.filter(check => check.inspected).reduce((sum, check) => sum + check.qualifiedQuantity, 0);
    const available = closure.quality !== undefined;
    const receipts = line.receipts ?? [];
    const attributionKnown = receipts.length > 0 && receipts.every(receipt => attributedReceiptIds.has(receipt.receiptId))
      && receipts.reduce((sum, receipt) => sum + receipt.actualQuantity, 0) === line.actualQuantity;
    const effectivePacked=line.effectivePackingQuantity===undefined?line.packingQuantity:line.effectivePackingQuantity;
    return {lineId: line.lineId, demand: line.orderedQuantity, received: line.actualQuantity,
      inspected: available ? inspected : null, qualified: available ? qualified : null,
      packed:line.packingQuantity, effectivePacked, remainingReceipt: Math.max(0, line.orderedQuantity - line.actualQuantity),
      factoryAttribution: attributionKnown ? 'known' : 'unknown',
      remainingShipment: effectivePacked === null ? null : Math.max(0, line.orderedQuantity - effectivePacked),
      qualityConflict: available && (inspected > line.actualQuantity || qualified > inspected),
      qualityGap: available ? Math.max(0, line.actualQuantity - inspected) : null, reasons: available ? [] : ['尚未取得到仓质检覆盖记录']};
  });
  return {revision: closure.revision, factoryAttribution: lines.length > 0 && lines.every(line => line.factoryAttribution === 'known') ? 'known' : 'unknown', lines};
}
