import type {PoolClient} from 'pg';
import type {SeriesPlanSnapshot} from '@dx-rework/contracts/digital-series-plan';
import type {JourneyRequirementTarget, OrderJourney} from '@dx-rework/contracts/digital-production-journey';
import type {AdoptedRequirementPlan} from './journey-business-progress.js';
import {isCalendarDate} from '@dx-rework/contracts/series-calendar';

type SavedPlan = {planId: string; snapshot: SeriesPlanSnapshot};
const dateValid = (value: string) => isCalendarDate(value);
/** Only persisted adoption snapshots supply targets. Preview/status=planned is not adoption. */
export function adoptedJourneyTargets(current: SavedPlan, history: readonly SavedPlan[], lineIds: readonly string[]): AdoptedRequirementPlan {
  const targets = new Map<string, JourneyRequirementTarget[]>();
  const plan = current.snapshot;
  const add = (key: string, at: string, precision: 'date' | 'instant', scopeRef: string, retained: number | null = null) => {
    if (precision === 'date' ? !dateValid(at) : !/(?:Z|[+-]\d{2}:\d{2})$/.test(at) || !Number.isFinite(Date.parse(at))) return;
    const origin = retained === null ? current : history.find(row => row.snapshot.revision === retained);
    // A legacy retained date without its original adoption cannot be labelled as a new plan date.
    if (!origin) return;
    targets.set(key, [...(targets.get(key) ?? []), {source: 'series_plan', planId: origin.planId,
      revision: origin.snapshot.revision, scopeRef, at, precision, retainedFromRevision: retained}]);
  };
  for (const [key, milestone] of [['customer_sample', 'client_sample_approval'], ['warehouse_dispatch', 'processing_dispatch']] as const) {
    const target = plan.milestones.find(row => row.key === milestone && row.scopeRef === 'whole');
    if (target?.targetDate) add(key, target.targetDate, 'date', 'whole', target.retainedFromRevision);
  }
  const mappings = {production_instruction: 'instruction', bulk_pattern: 'pattern_marker', bulk_marker: 'pattern_marker',
    warehouse_preshrink: 'fabric_preshrink', bulk_cutting: 'cutting', process_logistics: 'post_cut_craft',
    bulk_qc: 'post_cut_check', production_reporting: 'factory_production', receiving_inspection: 'garment_qc', packing: 'packing'};
  const perPo = new Set(['cutting', 'post_cut_craft', 'post_cut_check', 'factory_production', 'garment_qc', 'packing']);
  for (const [key, graphKey] of Object.entries(mappings)) {
    const scopes = perPo.has(graphKey) ? lineIds.map(id => `po:${id}`) : ['whole'];
    const rows = scopes.map(scope => plan.dependencies?.find(row => row.id === (scope === 'whole' ? graphKey : `${graphKey}:${scope}`) && row.scopeRef === scope));
    // Partial PO coverage must not masquerade as a complete whole-order target.
    if (!rows.length || rows.some(row => !row?.endAt || row.basis === 'unknown')) continue;
    for (const row of rows) add(key, row!.endAt!, 'instant', row!.scopeRef);
    // A scope can have an invalid original timestamp independently of
    // other PO scopes. Keep this requirement uncovered rather than using the
    // remaining date as a complete whole-order target.
    if(targets.get(key)?.length!==rows.length)targets.delete(key);
  }
  return {planId: current.planId, revision: plan.revision, targets};
}

export async function readJourneyAdoptedPlan(db: Pick<PoolClient, 'query'>, orderId: string, lines: OrderJourney['lines']): Promise<AdoptedRequirementPlan | null> {
  if (!(await db.query("SELECT to_regclass('digital_series_plans') AS t")).rows[0]?.t) return null;
  const rows = (await db.query<{plan_id: string; snapshot_json: SeriesPlanSnapshot}>(
    'SELECT plan_id,snapshot_json FROM digital_series_plans WHERE production_order_id=$1 ORDER BY revision DESC', [orderId])).rows;
  const history = rows.map(row => ({planId: row.plan_id, snapshot: row.snapshot_json}));
  return history.length ? adoptedJourneyTargets(history[0]!, history, lines.map(line => line.id)) : null;
}
