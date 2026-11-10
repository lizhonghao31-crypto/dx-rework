import {
  JOURNEY_STAGES, isJourneyPlanningNode,
  type JourneyBusinessDate, type JourneyBusinessRequirement, type JourneyNode,
  type JourneyVisualProgress, type OrderJourney,
} from '@dx-rework/contracts/digital-production-journey';
import { slaDateBoundary } from '@dx-rework/domain/digital-sla-plan';
import { journeyActualPoint } from './journey-progress-dates.js';

const instant = (at: string | null | undefined): number | null => {
  if (!at || !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(at)) return null;
  const value = Date.parse(at);
  return Number.isFinite(value) ? value : null;
};
const sameTime = (a: string | undefined, b: string) => instant(a) !== null && instant(a) === instant(b);
const unknownDate = (): JourneyBusinessDate => ({ at: null, precision: 'unknown', quality: 'unknown', status: 'unknown', covered: 0, total: 0, reasons: [] });
const copyDate = (date: JourneyBusinessDate | undefined): JourneyBusinessDate => date
  ? { ...date, reasons: [...date.reasons], ...(date.coveredAt ? { coveredAt: { ...date.coveredAt } } : {}) }
  : unknownDate();

/** A forecast day has the existing Beijing exclusive boundary for calculation.
 * Keep its original date/precision for display; it is never an actual event.
 */
function forecastBoundary(expected: JourneyBusinessDate): number | null {
  if (expected.status !== 'complete') return null;
  if (expected.precision === 'instant') return instant(expected.at);
  if (expected.precision !== 'date' || !expected.at) return null;
  try {
    return instant(slaDateBoundary(expected.at).at);
  } catch (error) {
    if (error instanceof Error && error.message === 'Invalid SLA calendar date') return null;
    throw error;
  }
}

/** Natural elapsed time is independent from each node's business SLA calendar.
 * A date-only start without an approved calculation boundary remains unknown.
 */
export function naturalTimeRatio(start: string | null, expected: JourneyBusinessDate, asOf: string): number | null {
  const from = instant(start), now = instant(asOf);
  const until = forecastBoundary(expected);
  if (from === null || until === null || now === null || until <= from) return null;
  return Math.max(0, Math.min(1, (now - from) / (until - from)));
}

/** Only effective current execution entries establish a start. Creation's exact
 * event is its own start; an old inherited work end is not current adoption.
 * Missing starts on an already-started scope cannot be replaced with updatedAt,
 * a sibling completion, an old round or the observation time.
 */
function recordedStart(rows: JourneyBusinessRequirement[], nodes: JourneyNode[], asOf: string): string | null {
  const required = rows.filter(row => row.applicability === 'applicable');
  if (!required.length || rows.some(row => row.applicability === 'unknown') || required.some(row => !row.instanceIds.length)) return null;
  const ids = new Set(required.flatMap(row => row.instanceIds));
  const current = nodes.filter(node => ids.has(node.instanceId));
  if (current.length !== ids.size) return null;
  const now = instant(asOf);
  if (now === null) return null;
  const starts: number[] = [];
  const milestoneUpperBounds: number[] = [];
  for (const node of current) {
    const creation = node.stage === 'creation' && ['order_information', 'product_development'].includes(node.key)
      && node.actualQuality === 'verified' ? node.actualAt : null;
    const at = instant(node.enteredAt ?? creation);
    if (at !== null) {
      if (at > now) return null;
      starts.push(at);
    } else {
      if (node.enteredAt) return null;
      const completion = journeyActualPoint(node, asOf);
      if (node.state === 'inherited' && completion?.precision === 'instant') starts.push(Date.parse(completion.at));
      // Native milestones and quantity aggregates have no separate task-entry
      // event. Their effective completion does not erase an independent
      // known scope start, nor become a fabricated enteredAt for that node.
      else if (node.state === 'completed' && node.occurrence === null
        && node.instanceId === `${node.key}:${node.round ?? 0}`) {
        if (completion) milestoneUpperBounds.push(completion.precision === 'instant' ? Date.parse(completion.at)
          : Date.parse(slaDateBoundary(completion.at).at!) - 1); // comparison bound only, never an actual event
      } else if (['active', 'blocked', 'completed', 'inherited', 'cancelled'].includes(node.state)) return null;
    }
  }
  const first = starts.length ? Math.min(...starts) : null;
  return first !== null && milestoneUpperBounds.every(end => end >= first) ? new Date(first).toISOString() : null;
}

/** v2 presentation reads the already-frozen B from the same authorized
 * projection. It does not replace native responsibility D or calculate a new
 * forecast/baseline from current time. Legacy dates keep their original meaning. */
function fixedExpectedDate(targets:NonNullable<JourneyNode['fixedTargets']>):JourneyBusinessDate{
 if(!targets.length||targets.some(target=>!target.progress.goalDelta.targetAt))return unknownDate();
 const latest=targets.reduce((a,b)=>Date.parse(a.progress.goalDelta.targetAt!)>=Date.parse(b.progress.goalDelta.targetAt!)?a:b).progress.goalDelta;
 return {at:latest.targetPrecision==='date'?latest.targetDate:latest.targetAt,precision:latest.targetPrecision,quality:'recorded',status:'complete',covered:targets.length,total:targets.length,reasons:[]};
}

/** Versioned presentation only. Reuses the original one-kind/every-effective-
 * instance requirements, including native PO, replacement and closure evidence.
 * It does not rewrite their n/m statistics, dates, authorization or lifecycle.
 */
export function journeyVisualProgress(order: OrderJourney, asOf: string): JourneyVisualProgress {
  const progress = order.businessProgress;
  const observed = Boolean(progress && sameTime(progress.asOf, asOf));
  const dates = observed && sameTime(progress?.dates?.asOf, asOf) ? progress?.dates : undefined;
  const nodes = order.stages.flatMap(stage => stage.nodes).filter(node => node.current && !isJourneyPlanningNode(node));
  const rows = observed ? progress!.requirements : [];
  const stages = JOURNEY_STAGES.map(stage => {
    const relevant = rows.filter(row => row.stage === stage.key);
    const applicable = relevant.filter(row => row.applicability === 'applicable');
    const unknown = relevant.filter(row => row.applicability === 'unknown').length;
    const duplicate = new Set(relevant.map(row => row.key)).size !== relevant.length;
    const excluded = !order.orderId && stage.key !== 'development';
    const missing = !excluded && (!observed || !relevant.length);
    const unavailable = !excluded && (missing || unknown > 0 || duplicate);
    const completed = applicable.filter(row => row.completed).length;
    const applicability = excluded || !unavailable && !applicable.length ? 'not_applicable' as const
      : unavailable ? 'unknown' as const : 'applicable' as const;
    const date = dates?.stages.find(value => value.key === stage.key);
    // Adopted v2 displays its immutable B; legacy keeps its original forecast.
    // Responsibility D and current F remain distinct in the node detail.
    const fixedTargets=order.fixedSchedule?nodes.filter(node=>node.stage===stage.key&&node.current).flatMap(node=>node.fixedTargets??[]):null;
    const expected = fixedTargets?fixedExpectedDate(fixedTargets):copyDate(date?.forecast), actual = copyDate(date?.actual);
    const startedAt = applicability === 'applicable' ? recordedStart(relevant, nodes, asOf) : null;
    return { key: stage.key, applicability, applicable: applicable.length, completed, unknown: unknown + (missing || duplicate ? 1 : 0),
      actualRatio: applicability === 'applicable' ? completed / applicable.length : null,
      timeRatio: naturalTimeRatio(startedAt, expected, asOf), startedAt, expected, actual,
      risk: order.display?.stages.find(value => value.key === stage.key)?.risk ?? 'unknown' as const };
  });
  const applicable = stages.filter(stage => stage.applicability === 'applicable');
  const unknownStages = stages.filter(stage => stage.applicability === 'unknown').length;
  const fixed=order.fixedSchedule,planEnd=fixed?.durationSummary.planEnd,terminalTargets=fixed?.scopes.flatMap(scope=>scope.nodes.filter(node=>node.goalDelta.targetAt===planEnd).map(progress=>({scopeRef:scope.scopeRef,lineId:scope.lineId,progress})))??[];
  const expected = fixed?planEnd?fixedExpectedDate(terminalTargets):unknownDate():copyDate(dates?.overall.forecast);
  const completed=fixed?.durationSummary.deliveryCompletedAt;
  const actual = fixed?completed&&completed.precision!=='unknown'?{at:completed.precision==='date'?completed.date:completed.at,precision:completed.precision,quality:'recorded' as const,status:'complete' as const,covered:fixed.scopes.length,total:fixed.scopes.length,reasons:[]}:unknownDate():copyDate(dates?.overall.actual);
  const startedAt = observed && !unknownStages ? recordedStart(rows, nodes, asOf) : null;
  return { ruleVersion: 'journey-visual-v2', asOf,
    actualRatio: unknownStages || !applicable.length ? null : applicable.reduce((sum, stage) => sum + stage.actualRatio!, 0) / applicable.length,
    timeRatio: naturalTimeRatio(startedAt, expected, asOf), startedAt,
    applicableStages: applicable.length, completedStages: applicable.filter(stage => stage.actualRatio === 1).length, unknownStages,
    expected, actual, stages };
}
