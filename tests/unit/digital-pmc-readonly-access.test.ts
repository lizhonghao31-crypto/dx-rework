import {describe, expect, it, vi} from 'vitest';
import type {Pool, PoolClient} from 'pg';
import type {BudgetDocument} from '@dx-rework/contracts/digital-budget';
import {PatternWorkspaceFilterSchema} from '@dx-rework/contracts/digital-development-workspace';
import {JourneyFilterSchema} from '@dx-rework/contracts/digital-production-journey';
import type {TrustedActorContext} from '../../apps/api/src/tools/repositories.js';
import {DigitalProductionAccessPolicy, isDigitalLeader, isDigitalManagementReader} from '../../apps/api/src/production-platform/access-policy.js';
import {assertSlaSettingsActor, assertSlaSettingsReadActor} from '../../apps/api/src/production-platform/sla-settings-authority.js';
import {SeriesPlanService} from '../../apps/api/src/production-platform/series-plan-service.js';
import {DigitalQuotationService} from '../../apps/api/src/production-platform/quotation-service.js';
import {OrderClosureService} from '../../apps/api/src/production-platform/order-closure-service.js';
import {DevelopmentWorkspaceQuery} from '../../apps/api/src/production-platform/development-workspace-query.js';
import {DigitalJourneyQuery} from '../../apps/api/src/production-platform/journey-query.js';

// These tests isolate authorization, not the native fact projection itself.
vi.mock('../../apps/api/src/production-platform/series-plan-facts.js', () => ({
  readSeriesPlanFacts: vi.fn(async () => ({facts: [], revisions: {}, document: null})),
}));

const ACTOR = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const ORDER = '33333333-3333-4333-8333-333333333333';
const TASK = '44444444-4444-4444-8444-444444444444';
const ROW = '55555555-5555-4555-8555-555555555555';
const QUOTE = '66666666-6666-4666-8666-666666666666';
const actor = (...roles: string[]): TrustedActorContext => ({
  actorId: ACTOR, actorRoles: roles, authorizationCapability: 'pattern_room:orders:view', requestId: 'pmc-readonly-test',
});
const order = (overrides: Record<string, unknown> = {}) => ({
  production_order_id: ORDER, source_id: null, created_by: OTHER, primary_merchandiser_id: OTHER,
  design_style_no: 'TEST-PMC-READ', customer_code: 'PD', version: 1,
  sales_year: 2027, sales_series: 'P03', requires_color_matching: false, ...overrides,
});
type ReadRows = (sql: string, values: unknown[]) => Record<string, unknown>[] | undefined;

function database(activeRoles: string[], readRows: ReadRows) {
  const query = vi.fn(async (raw: string, values: unknown[] = []) => {
    if(raw==="SELECT to_regclass('digital_timeline_adoptions') AS relation")return {rows:[{relation:null}],rowCount:1}; // This legacy permission fixture has no v2 adoption; assertions remain unchanged.

    const sql = raw.replace(/\s+/g, ' ').trim();
    // Model the native batching envelope while evaluating only the original
    // strict per-object SELECT fixtures. Unknown SQL still fails this regression.
    const batch = sql.match(/^SELECT requested\.ordinal AS "__dx_journey_batch_index",facts\.\* FROM unnest\(\$1::(?:uuid|text)\[\]\) WITH ORDINALITY AS requested\(id,ordinal\) CROSS JOIN LATERAL \(SELECT original\.\*,row_number\(\) OVER \(\) AS "__dx_journey_row_index" FROM \((.+)\) AS original\) AS facts ORDER BY requested\.ordinal,facts\."__dx_journey_row_index"$/);
    if (batch) {
      if (!Array.isArray(values[0]) || values[0].some(id => typeof id !== 'string')) throw Error('Invalid permission fixture batch scope');
      const original = batch[1]!.replace(/\brequested\.id\b/g, '$1'), rows = values[0].flatMap((id, index) => {
        const facts = readRows(original, [id]);
        if (facts === undefined) throw Error(`Unexpected original SELECT in permission batch: ${original}`);
        return facts.map((fact, row) => ({__dx_journey_batch_index: index + 1, ...fact, __dx_journey_row_index: row + 1}));
      });
      const fields = [...new Set(['__dx_journey_batch_index', ...rows.flatMap(row => Object.keys(row)), '__dx_journey_row_index'])].map(name => ({name}));
      return {rows, rowCount: rows.length, fields};
    }
    let rows: Record<string, unknown>[] | undefined;
    if (/^(BEGIN|COMMIT|ROLLBACK)\b/.test(sql) || sql.startsWith('SELECT pg_advisory_xact_lock(')) rows = [];
    else if (["SELECT to_regclass('digital_order_time_plan_versions') AS relation", "SELECT to_regclass('digital_whole_order_deleted_objects') AS relation"].includes(sql)) rows=[{relation:null}];
    else if (sql.startsWith('SELECT 1 FROM app_users u') && sql.includes('user_role_assignments')) {
      rows = values[0] === ACTOR && activeRoles.includes(String(values[1])) ? [{allowed: 1}] : [];
    } else rows = readRows(sql, values);
    if (rows === undefined) throw new Error(`Unexpected query in permission regression: ${sql}`);
    return {rows, rowCount: rows.length};
  });
  const release = vi.fn();
  const client = {query, release} as unknown as PoolClient;
  const pool = {query, connect: vi.fn(async () => client)} as unknown as Pool;
  return {query, pool, client, release};
}

function seriesDatabase(roles: string[], overrides: Record<string, unknown> = {}) {
  return database(roles, (sql, values) => {
    if (sql.startsWith('SELECT * FROM digital_production_orders ')) return values[0] === ORDER ? [order(overrides)] : [];
    if (sql.startsWith('SELECT snapshot_json FROM digital_series_plans ')
      || sql.startsWith('SELECT 1 FROM digital_production_resource_lifecycle ')
      || sql.startsWith('SELECT * FROM digital_series_profiles ')
      || sql.startsWith('SELECT DISTINCT ON(config_key) ')
      || sql.startsWith('SELECT line_id AS "lineId"')
      || sql.startsWith('SELECT r.*,r.candidate_date::text')) return [];
    return undefined;
  });
}

describe('PMC management read scope is separate from command authority', () => {
  it.each([
    {roles: ['pmc'], reader: true, leader: false},
    {roles: ['pmc', 'pattern_room_worker'], reader: true, leader: false},
    {roles: ['pmc', 'production_management'], reader: true, leader: true},
    {roles: ['production_management'], reader: true, leader: true},
    {roles: ['owner_group'], reader: true, leader: true},
    {roles: ['root_superuser'], reader: true, leader: true},
    {roles: ['quality_control'], reader: false, leader: false},
    {roles: ['finance'], reader: false, leader: false},
  ])('keeps read/leader distinction for $roles', ({roles, reader, leader}) => {
    expect(isDigitalManagementReader(actor(...roles))).toBe(reader);
    expect(isDigitalLeader(actor(...roles))).toBe(leader);
  });

  it('reads another existing order and task, without granting execution or inventing a missing resource', async () => {
    const db = database(['pmc'], (sql, values) => {
      if (sql.startsWith('SELECT * FROM digital_production_orders ')) return values[0] === ORDER ? [order()] : [];
      if (sql.startsWith('SELECT * FROM digital_production_task_access ')) return [{task_id: TASK, task_kind: 'bulk_pattern', production_order_id: ORDER, assignee_id: ACTOR, required_role: 'pattern_room_worker'}];
      return undefined;
    });
    const policy = new DigitalProductionAccessPolicy(db.pool), pmc = actor('pmc');
    expect(await policy.allowed(pmc, 'order', ORDER, 'technical')).toBe(true);
    expect(await policy.allowed(pmc, 'order', ORDER, 'budget')).toBe(true);
    expect(await policy.allowed(pmc, 'task', TASK, 'technical')).toBe(true);
    expect(await policy.allowed(pmc, 'task', TASK, 'budget')).toBe(false);
    expect(await policy.allowed(pmc, 'task', TASK, 'execute')).toBe(false);
    expect(await policy.allowed(pmc, 'order', OTHER, 'technical')).toBe(false);
  });

  it('preserves actual worker execution only for the assigned task', async () => {
    const db = database(['pmc', 'pattern_room_worker'], (sql, values) => sql.startsWith('SELECT * FROM digital_production_task_access ')
      ? [{task_kind: 'bulk_pattern', assignee_id: values[0] === TASK ? ACTOR : OTHER, required_role: 'pattern_room_worker'}] : undefined);
    const policy = new DigitalProductionAccessPolicy(db.pool), mixed = actor('pmc', 'pattern_room_worker');
    expect(await policy.allowed(mixed, 'task', TASK, 'execute')).toBe(true);
    expect(await policy.allowed(mixed, 'task', OTHER, 'execute')).toBe(false);
  });
});

describe('PMC SLA and series reads do not become management or requester rights', () => {
  it('allows active PMC reads, rejects revoked PMC, and keeps both original authority modes closed', async () => {
    const db = database(['pmc'], () => undefined), pmc = actor('pmc');
    await expect(assertSlaSettingsReadActor(db.client, pmc)).resolves.toBeUndefined();
    await expect(assertSlaSettingsActor(db.client, pmc)).rejects.toMatchObject({code: 'FORBIDDEN', statusCode: 403});
    await expect(assertSlaSettingsActor(db.client, pmc, true)).rejects.toMatchObject({code: 'FORBIDDEN', statusCode: 403});
    await expect(assertSlaSettingsReadActor(database([], () => undefined).client, pmc)).rejects.toMatchObject({statusCode: 403});
  });

  it('retains a real management role and its locked write check, without reviving a revoked one', async () => {
    const mixed = actor('pmc', 'production_management'), db = database(['pmc', 'production_management'], () => undefined);
    await expect(assertSlaSettingsActor(db.client, mixed, true)).resolves.toBeUndefined();
    expect(db.query.mock.calls.some(([sql]) => sql.includes('FOR SHARE OF u,a,r,i'))).toBe(true);
    const revoked = database(['pmc'], () => undefined);
    await expect(assertSlaSettingsReadActor(revoked.client, mixed)).resolves.toBeUndefined();
    await expect(assertSlaSettingsActor(revoked.client, mixed, true)).rejects.toMatchObject({statusCode: 403});
  });

  it.each([
    {roles: ['pmc'], activeRoles: ['pmc'], own: false, edit: false, apply: false, request: false},
    {roles: ['production_management'], activeRoles: ['production_management'], own: false, edit: false, apply: true, request: true},
    {roles: ['pmc', 'production_management'], activeRoles: ['pmc', 'production_management'], own: false, edit: false, apply: true, request: true},
    {roles: ['pmc', 'production_management'], activeRoles: ['pmc'], own: false, edit: false, apply: false, request: false},
    {roles: ['pmc', 'sample_designer'], activeRoles: ['pmc', 'sample_designer'], own: true, edit: true, apply: false, request: true},
    {roles: ['pmc', 'sample_designer'], activeRoles: ['pmc', 'sample_designer'], own: false, edit: false, apply: false, request: false},
  ])('projects series read flags for $roles, own=$own, active=$activeRoles', async ({roles, activeRoles, own, edit, apply, request}) => {
    const db = seriesDatabase(activeRoles, {created_by: own ? ACTOR : OTHER});
    const result = await new SeriesPlanService(db.pool).read(actor(...roles), ORDER);
    expect(result).toMatchObject({orderId: ORDER, active: true, canEditSeries: edit, canApply: apply, canRequest: request});
    expect(db.release).toHaveBeenCalledOnce();
  });

  it('reads profiles but rejects preview, request, apply and profile publication for pure PMC', async () => {
    const db = seriesDatabase(['pmc']), service = new SeriesPlanService(db.pool), pmc = actor('pmc');
    const input = {expectedOrderVersion: 1, expectedPlanRevision: 0, plannedShippingDate: '2027-01-15'};
    await expect(service.profiles(pmc)).resolves.toEqual({profiles: []});
    await expect(service.preview(pmc, ORDER, input)).rejects.toMatchObject({statusCode: 404});
    await expect(service.request(pmc, ORDER, {...input, reason: 'TEST readonly boundary'}, 'pmc-request')).rejects.toMatchObject({statusCode: 404});
    await expect(service.apply(pmc, ORDER, {...input, reason: 'TEST readonly boundary', previewToken: 'not-an-authority'}, 'pmc-apply')).rejects.toMatchObject({statusCode: 404});
    await expect(service.saveProfile(pmc, {expectedVersion: 0, monthOffset: -2, shippingDay: null, reason: 'TEST readonly boundary'}, 'pmc-profile')).rejects.toMatchObject({statusCode: 403});
    expect(db.query.mock.calls.some(([sql]) => /^(INSERT|UPDATE|DELETE)\b/.test(sql))).toBe(false);
  });
});

const document: BudgetDocument = {
  fabricType: '', productCategory: '', monthSeries: '', date: null, currency: '人民币', freight: '', cm: '', salePrice: '',
  outsourcingScope: '', outsourcingUnitPrice: '', imageAttachmentIds: [],
  rows: [{rowId: ROW, section: '主料', category: '', name: 'TEST fabric', specification: '', unit: '米', supplier: '', consumption: '1.2', unitPrice: '10'}],
};
function quotationDatabase(roles: string[], assignee = OTHER) {
  return database(roles, (sql, values) => {
    if (sql.startsWith('SELECT * FROM digital_production_orders ')) return [order()];
    if (sql.startsWith('SELECT * FROM digital_quotation_documents ')) return [{
      quote_id: QUOTE, source_id: null, production_order_id: ORDER, version: 1, confirmed_version: null, document,
      assignments: [{rowId: ROW, technicalAssigneeId: assignee, priceAssigneeId: OTHER, priceRole: 'sample_designer'}],
      consumption_sources: {}, price_sources: {},
    }];
    if (sql.startsWith('SELECT q.source_id,q.production_order_id ')) return values[0] ? [{source_id: null, production_order_id: ORDER}] : [];
    if (sql.startsWith('SELECT id,display_name FROM app_users ')) return [{id: ACTOR, display_name: 'TEST reader'}, {id: OTHER, display_name: 'TEST designer'}];
    if (sql.startsWith('SELECT version,quote_id,quote_version,status FROM digital_budget_documents ')) return [];
    if (sql.startsWith('SELECT version FROM digital_quotation_versions ')) return [{version: 1}];
    return undefined;
  });
}

describe('PMC full quotation reads preserve original row and command permissions', () => {
  it.each([['pmc'], ['production_management']])('reads full costs as %s without structure, confirmation or row edits', async role => {
    const db = quotationDatabase([role]), service = new DigitalQuotationService(db.pool, true);
    const result = await service.read(actor(role), {kind: 'order', id: ORDER});
    expect(result).toMatchObject({fullCost: true, document, canStructure: false, canConfirm: false, versions: [1]});
    expect(result.rows[0]).toMatchObject({unitPrice: '10', consumption: '1.2', canEditConsumption: false, canEditPrice: false});
    expect((await service.list(actor(role))).items).toHaveLength(1);
  });

  it('does not expose revoked PMC quotation data', async () => {
    const service = new DigitalQuotationService(quotationDatabase([]).pool, true);
    await expect(service.read(actor('pmc'), {kind: 'order', id: ORDER})).rejects.toMatchObject({statusCode: 404});
    await expect(service.list(actor('pmc'))).resolves.toEqual({items: []});
  });

  it.each([ACTOR, OTHER])('preserves a real assigned worker role without giving price or structure authority (assignee %s)', async assignee => {
    const db = quotationDatabase(['pmc', 'pattern_room_worker'], assignee);
    const result = await new DigitalQuotationService(db.pool, true).read(actor('pmc', 'pattern_room_worker'), {kind: 'order', id: ORDER});
    expect(result).toMatchObject({fullCost: true, canStructure: false, canConfirm: false});
    expect(result.rows[0]).toMatchObject({canEditConsumption: assignee === ACTOR, canEditPrice: false});
  });

  it('rejects pure PMC participants and write/replay entry before any command receipt or mutation', async () => {
    const db = quotationDatabase(['pmc']), service = new DigitalQuotationService(db.pool, true), pmc = actor('pmc'), resource = {kind: 'order' as const, id: ORDER};
    await expect(service.participants(pmc, resource)).rejects.toMatchObject({statusCode: 404});
    await expect(service.fillRow(pmc, resource, ROW, {expectedVersion: 1, consumption: '2'}, 'former-worker-command')).rejects.toMatchObject({statusCode: 404});
    expect(db.query.mock.calls.some(([sql]) => sql.includes('digital_production_commands') || /^(INSERT|UPDATE|DELETE)\b/.test(sql))).toBe(false);
  });
});

describe('PMC pattern board reads keep original dispatch boundary', () => {
  it('can read all and unassigned views but cannot open dispatch or designer workspaces', async () => {
    const list = vi.fn(async () => ({asOf: '2026-11-02T00:00:00.000Z', items: []}));
    const query = new DevelopmentWorkspaceQuery({list} as unknown as DigitalJourneyQuery), pmc = actor('pmc');
    await expect(query.pattern(pmc, PatternWorkspaceFilterSchema.parse({scope: 'all'}))).resolves.toMatchObject({items: [], total: 0});
    await expect(query.pattern(pmc, PatternWorkspaceFilterSchema.parse({scope: 'unassigned'}))).resolves.toMatchObject({items: [], total: 0});
    await expect(query.pattern(pmc, PatternWorkspaceFilterSchema.parse({scope: 'dispatch'}))).rejects.toMatchObject({statusCode: 403});
    await expect(query.designer(pmc, {page: 1, search: '', view: 'all'})).rejects.toMatchObject({statusCode: 403});
    expect(list).toHaveBeenCalledTimes(2);
  });
});

const RECEIPT = '77777777-7777-4777-8777-777777777777';
const BATCH = '88888888-8888-4888-8888-888888888888';
const REWORK = '99999999-9999-4999-8999-999999999999';
function closureDatabase(roles: string[]) {
  const receivedAt = '2026-10-24T08:00:00.000Z';
  return database(roles, (sql, values) => {
    if (sql.startsWith('SELECT * FROM digital_production_orders ')) return values[0] === ORDER ? [order()] : [];
    if (sql.startsWith('SELECT p.*,(')&&sql.includes('packing_absence_proven')) return [{line_id: ROW, po_number: 'TEST-PMC-PO', color: '黑', total_quantity: '10', cutting_id: TASK}];
    if (sql.startsWith('SELECT p.production_order_id,p.factory_decision_id,p.sourcing_decision_id')&&sql.includes('sourcing_factory_execution_lines')) {
      expect(values).toEqual([ORDER]);
      return [{production_order_id:QUOTE,factory_decision_id:null,line_id:ROW,quantity:10,target_date:null}];
    }
    if(sql.startsWith('SELECT po.line_id,map.child_id'))return [{line_id:ROW,child_id:TASK,sourcing_case_id:QUOTE,sourcing_line_position:1,approval_snapshot_id:null,source_line_id:ROW}];
    if(sql.includes('FROM unnest($1::uuid[]) requested(cutting_id)'))return [{group_key:`cut:${TASK}`,packing_revision_id:null,packing_quantity:null,packing_actual_time:null,packing_recorded_at:null,packing_scope_unresolved:false}];
    if (sql.includes('SELECT totals.*,action.receiving_batch_id')) return [{
      group_key: `cut:${TASK}`, receiving_batch_id: BATCH, current_actual_quantity: '3', document_quantity: '3',
      current_defective_quantity: '1', receipt_count: 1, packing_quantity: null,
    }];
    if (sql.startsWith('SELECT l.line_id,r.receipt_id,r.received_at')) return [{
      line_id: ROW, receipt_id: RECEIPT, received_at: receivedAt, after_state: {}, actual_quantity: '3', defective_quantity: '1',factory_production_id:QUOTE,factory_decision_id:null,
    }];
    if (sql.startsWith('SELECT l.line_id,r.*, (SELECT count(*)::int FROM rework_wage_items')) return [{
      line_id: ROW, rework_order_id: REWORK, rework_no: 'TEST-PMC-RW', status: 'completed',
      created_by: OTHER, merchandiser_user_id: OTHER, embroidery_merchandiser_user_id: null,
      problem_part: '袖口', problem_description: '返修', rework_quantity: 1, wage_items: 2, rework_kind: 'qc_rework',
    }];
    // The optional closure summary reads through the same original full-detail
    // permission. Model that SELECT without masking unexpected SQL or writes.
    if (sql.startsWith('SELECT item.configuration_item_id,item.process_name,item.execution_kind,')) {
      expect(values).toEqual([REWORK]);
      expect(sql).toContain('sum(rework_work_report_effective_quantity(report.work_report_id))');
      expect(sql).toContain("configuration.status='approved'");
      return [{configuration_item_id: ROW, process_name: 'TEST修补', execution_kind: 'inhouse', reported_quantity: '1', report_ids: [RECEIPT]}];
    }
    if (sql.startsWith('SELECT l.line_id,r.receipt_id,r.receiving_batch_id')) return [{
      line_id: ROW, receipt_id: RECEIPT, receiving_batch_id: BATCH, cutting_order_id: TASK,
      received_at: receivedAt, after_state: {}, quantity: '3', quantity_version: RECEIPT,
      event_id: null, payload: null, snapshot_id: null,
    }];
    if (sql.startsWith("SELECT payload->>'receiptId' AS id")) return [{id: RECEIPT}];
    if (sql.startsWith("SELECT child_id FROM digital_production_child_links WHERE module='production'")) return [{child_id: QUOTE}];
    if (sql.startsWith('SELECT after_state FROM audit_events ')) return [{after_state: {lines: [{sizes: [{quantity: 10}]}]}}];
    if (sql.startsWith('SELECT DISTINCT r.receipt_id,r.received_at')) return [{
      receipt_id: RECEIPT, received_at: receivedAt, actual_quantity: '3', event_id: RECEIPT,
      created_at: receivedAt, after_state: {}, deleted_at: null,
    }];
    if (sql.startsWith('SELECT e.event_id,e.payload,e.recorded_at AS application_recorded_at,s.*')
      || sql.startsWith('SELECT t.task_id,t.node_key,t.state,')
      || sql.startsWith('SELECT 1 FROM digital_production_task_access a JOIN digital_production_tasks t')
      || sql.startsWith('SELECT c.*,u.display_name FROM digital_order_closures c')
      || sql.startsWith('SELECT * FROM receiving_receipt_corrections ')
      || sql.startsWith('SELECT * FROM digital_sla_order_snapshots ')
      || sql.startsWith('SELECT s.production_order_id,s.factory_decision_id,s.shipped_on::text')
      || sql.startsWith('SELECT s.production_order_id,s.factory_decision_id,s.recorded_quantity,')) return [];
    return undefined;
  });
}

describe('PMC closure reads retain native links without acquiring closure or QC authority', () => {
  it('matches management receiving, rework and historical facts on the same populated order', async () => {
    const pmcDb = closureDatabase(['pmc']), managerDb = closureDatabase(['production_management']);
    const readonly = await new OrderClosureService(pmcDb.pool).read(actor('pmc'), ORDER);
    const manager = await new OrderClosureService(managerDb.pool).read(actor('production_management'), ORDER);
    expect(manager.canClose).toBe(true);
    expect(readonly).toEqual({...manager, canClose: false});
    expect(readonly.factoryDeliveries).toMatchObject([{productionId:QUOTE,lineId:ROW,delivered:true,received:3,remaining:7,collected:false,status:'unknown'}]);
    expect(readonly).toMatchObject({
      canOpenReceiving: true, canOpenRework: true, canClose: false, canRecordQuality: false,
      collection: {expected: 10, received: 3, remaining: 7},
      lines: [{lineId: ROW, receivingBatchId: BATCH,
        receipts: [{receiptId: RECEIPT, actualQuantity: 3, defectiveQuantity: 1}],
        reworks: [{reworkId: REWORK, canView: true, status: 'completed', quantity: 1, wageItemCount: 2,
          businessSummary: {kind: 'qc_rework', processes: [{configurationItemId: ROW, reportedQuantity: 1, reportIds: [RECEIPT]}]}}]}],
    });
    await expect(new OrderClosureService(pmcDb.pool).read(actor('pmc'), OTHER)).rejects.toMatchObject({statusCode: 404});
    expect(pmcDb.query.mock.calls.some(([sql]) => /^(INSERT|UPDATE|DELETE)\b/.test(sql))).toBe(false);
  });

  it.each([
    {roles: ['pmc', 'pattern_room_worker'], active: ['pmc', 'pattern_room_worker'], close: false, quality: false},
    {roles: ['pmc', 'production_management'], active: ['pmc', 'production_management'], close: true, quality: false},
    {roles: ['pmc', 'production_management'], active: ['pmc'], close: false, quality: false},
    {roles: ['pmc', 'quality_control'], active: ['pmc', 'quality_control'], close: false, quality: true},
    {roles: ['pmc', 'quality_control'], active: ['pmc'], close: false, quality: false},
  ])('retains only original live write roles for $roles, active=$active', async ({roles, active, close, quality}) => {
    const db = closureDatabase(active);
    const result = await new OrderClosureService(db.pool).read(actor(...roles), ORDER);
    expect(result).toMatchObject({canOpenReceiving: true, canOpenRework: true, canClose: close, canRecordQuality: quality});
  });

  it('rejects pure PMC closure and quality commands before command replay or mutation', async () => {
    const db = closureDatabase(['pmc']), service = new OrderClosureService(db.pool), pmc = actor('pmc');
    const sheet = await service.read(pmc, ORDER);
    await expect(service.close(pmc, ORDER, {expectedRevision: sheet.revision, reason: 'TEST PMC cannot close'}, 'pmc-close'))
      .rejects.toMatchObject({statusCode: 403});
    await expect(service.recordQuality(pmc, ORDER, {
      receiptId: RECEIPT, quantityVersion: RECEIPT, occurredAt: '2026-10-24T09:00:00.000Z', qualifiedQuantity: 3, problem: '',
    }, 'pmc-quality')).rejects.toMatchObject({statusCode: 403});
    expect(db.query.mock.calls.some(([sql]) => sql.includes('digital_production_commands') || /^(INSERT|UPDATE|DELETE)\b/.test(sql))).toBe(false);
    expect(db.release).toHaveBeenCalledTimes(2);
  });
});

function linkedJourneyDatabase(roles: string[]) {
  const createdAt = '2026-10-24T08:00:00.000Z', completedAt = '2026-10-24T09:00:00.000Z';
  const mother = order({temporary_style_no: 'TEST-PMC-TEMP', product_group: '男装', created_at: createdAt, contract_delivery_date: null});
  const task = {
    task_id: TASK, task_kind: 'bulk_pattern', source_id: null, production_order_id: ORDER,
    assignee_id: OTHER, required_role: 'pattern_room_worker', route_version: 1, occurrence: 1,
    completed_quality: '现场登记', route_instance_id: QUOTE, original_state: 'completed', returned: false,
  };
  return database(roles, (sql, values) => {
    if (sql === "SELECT to_regclass('digital_bulk_preshrink_corrections') AS relation") return [{relation:'digital_bulk_preshrink_corrections'}];
    if (sql === 'SELECT preshrink_task_id FROM digital_bulk_preshrink_corrections ORDER BY preshrink_task_id') return [];
    if (sql === 'SELECT CURRENT_TIMESTAMP AS as_of') return [{as_of: completedAt}];
    if (sql.startsWith('WITH live_roles AS (')) return [{source: null, order: mother}];
    if (sql.startsWith('SELECT * FROM digital_production_orders ')) return values[0] === ORDER ? [mother] : [];
    if (sql.startsWith('SELECT a.task_id,a.task_kind,a.source_id,')) return [task];
    if (sql.startsWith('SELECT p.preparation_id FROM digital_bulk_preparations p')) return [{preparation_id: QUOTE}];
    if (sql.startsWith('SELECT t.*,a.source_id,a.production_order_id,')) return [{
      ...task, state: 'completed', entered_at: createdAt, entered_quality: '现场登记', created_at: createdAt, completed_at: completedAt,
      paused: false, assignee_name: 'TEST other worker', assignee_active: true, label: '大货纸样',
      due_at: null, warning_at: null, sla_seconds: null, policy_version: 1, condition_keys: [], completion_keys: [], predecessors: [],
      route_tasks: [{node: 'bulk_pattern', key: 'bulk_pattern', state: 'completed'}],
      completion: {actor_id: OTHER, actor_name: 'TEST other worker', recorded_at: completedAt}, later_owner: null, previous_owner_name: null,
    }];
    if (sql.startsWith('SELECT display_name FROM app_users WHERE id=$1')) return [{display_name: 'TEST other worker'}];
    if (sql.startsWith('SELECT id,display_name FROM app_users WHERE id=ANY')) return [{id: OTHER, display_name: 'TEST other worker'}];
    if (sql.startsWith('SELECT l.line_id AS id,l.po_number AS po,')) return [{id: ROW, po: 'TEST-PMC-PO', color: '黑', formalStyleNo: null, temporaryStyleNo: 'TEST-PMC-TEMP', orderedQuantity: 10}];
    if (sql.startsWith('SELECT module,child_id FROM digital_production_child_links ')) return [{module: 'receiving', child_id: RECEIPT}, {module: 'rework', child_id: REWORK}];
    if (sql.startsWith('SELECT module,child_id,line_id FROM digital_production_child_lines ')) return [{module: 'receiving', child_id: RECEIPT, line_id: ROW}, {module: 'rework', child_id: REWORK, line_id: ROW}];
    if (sql === "SELECT to_regclass('digital_factory_facts') AS relation") return [{relation: 'digital_factory_facts'}];
    if (sql.startsWith('SELECT v.version,v.source_round,v.published_at,v.published_by ')
      || sql.startsWith('SELECT DISTINCT ON(node_key) ')
      || sql.startsWith('SELECT e.event_id,e.occurred_at,e.payload,u.display_name ')
      || sql.startsWith('SELECT f.*,u.display_name,v.order_snapshot ')) return [];
    return undefined;
  });
}

const SOURCE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
function sourceJourneyDatabase(roles: string[]) {
  const source = {source_id: SOURCE, development_type: '头版', created_by: OTHER, design_style_no: 'TEST-PMC-SOURCE', temporary_style_no: null, customer_code: 'PD', created_at: '2026-10-24T08:00:00.000Z'};
  return database(roles, (sql, values) => {
    if (sql === 'SELECT CURRENT_TIMESTAMP AS as_of') return [{as_of: '2026-10-24T09:00:00.000Z'}];
    if (sql.startsWith('WITH live_roles AS (')) return [{source, order: null}];
    if (sql.startsWith('SELECT * FROM digital_production_sources ')) return values[0] === SOURCE ? [source] : [];
    if (sql.startsWith('SELECT display_name FROM app_users WHERE id=$1')) return [{display_name: 'TEST other designer'}];
    if (sql.startsWith('SELECT id,display_name FROM app_users WHERE id=ANY')) return [{id: OTHER, display_name: 'TEST other designer'}];
    if (sql.startsWith('SELECT coalesce(max(round_number),1)::int AS round ')) return [{round: 1}];
    for (const relation of ['digital_development_amendments', 'digital_development_sla_plans', 'digital_preparation_responsibilities']) {
      if (sql === `SELECT to_regclass('${relation}') AS relation`) return [{relation}];
    }
    if (sql.startsWith('SELECT a.task_id,a.task_kind,a.source_id,')
      || sql.startsWith('SELECT * FROM digital_development_effective_documents ')
      || sql.startsWith('SELECT * FROM digital_development_effective_rounds ')
      || sql.startsWith('SELECT * FROM digital_preparation_responsibilities ')
      || sql.startsWith('SELECT * FROM digital_development_sla_plans ')
      || sql.startsWith("SELECT t.task_id,t.state,t.entered_at,t.entered_quality,t.completed_at,t.completed_quality,a.task_kind,") && values[0] === SOURCE
      || sql.startsWith('SELECT DISTINCT ON(node_key) ')
      || sql.startsWith('SELECT 1 FROM digital_production_resource_lifecycle ')
      || sql.startsWith('WITH authorized_events AS (')) return [];
    return undefined;
  });
}

describe('PMC Journey linked records and timing remain read projections', () => {
  it('projects the same exact receiving and rework links as management through the public board query', async () => {
    const read = async (role: string) => {
      const db = linkedJourneyDatabase([role]);
      const result = await new DigitalJourneyQuery(db.pool).list(actor(role), JourneyFilterSchema.parse({search: 'TEST-PMC-READ'}), true, undefined, {details: false, patternBusiness: 'bulk'});
      expect(db.query.mock.calls.some(([sql]) => sql.startsWith('SELECT requested.ordinal AS "__dx_journey_batch_index"'))).toBe(true);
      expect(db.query.mock.calls.some(([sql]) => /^(INSERT|UPDATE|DELETE)\b/.test(sql))).toBe(false);
      return result;
    };
    const pmc = await read('pmc'), manager = await read('production_management');
    expect(pmc.items).toHaveLength(1);
    expect(pmc.items).toEqual(manager.items);
    expect(pmc.items[0]!.links).toEqual([
      {domain: 'receiving', id: RECEIPT, url: `/ui/digital-production?closure=${ORDER}#receipt-${RECEIPT}`, version: null, lineId: ROW, mode: 'read'},
      {domain: 'rework', id: REWORK, url: `/ui/tasks/${REWORK}`, version: null, lineId: ROW, mode: 'read'},
    ]);
    expect(pmc.canManagePolicies).toBe(false);
    expect(manager.canManagePolicies).toBe(true);
  });

  it('reads the same legacy SLA coverage as management without inventing a historical plan', async () => {
    const pmcDb = sourceJourneyDatabase(['pmc']), managerDb = sourceJourneyDatabase(['production_management']);
    const pmc = await new DigitalJourneyQuery(pmcDb.pool).read(actor('pmc'), SOURCE, undefined, true);
    const manager = await new DigitalJourneyQuery(managerDb.pool).read(actor('production_management'), SOURCE, undefined, true);
    expect(pmc.supervision).toMatchObject({status: 'legacy_unenrolled', originalRevision: null, currentRevision: null, nodes: [], coverage: [{key: 'plan'}]});
    expect(pmc.supervision).toEqual({...manager.supervision, asOf: pmc.supervision!.asOf});
    expect(pmcDb.query.mock.calls.some(([sql]) => /^(INSERT|UPDATE|DELETE)\b/.test(sql))).toBe(false);
  });

  it.each([
    {roles: ['pmc'], active: [], status: 'limited'},
    {roles: ['pmc', 'pattern_room_worker'], active: ['pattern_room_worker'], status: 'limited'},
    {roles: ['pmc', 'pattern_room_worker'], active: ['pmc', 'pattern_room_worker'], status: 'legacy_unenrolled'},
    {roles: ['pmc', 'production_management'], active: ['production_management'], status: 'legacy_unenrolled'},
  ])('retains the active-role timing guard for $roles, active=$active', async ({roles, active, status}) => {
    const db = sourceJourneyDatabase(active);
    const result = await new DigitalJourneyQuery(db.pool).read(actor(...roles), SOURCE, undefined, true);
    expect(result.supervision?.status).toBe(status);
  });

  it('keeps an unrelated ordinary worker outside whole-source Journey scope', async () => {
    const db = sourceJourneyDatabase(['pattern_room_worker']);
    await expect(new DigitalJourneyQuery(db.pool).read(actor('pattern_room_worker'), SOURCE, undefined, true)).rejects.toMatchObject({statusCode: 404});
    expect(db.query.mock.calls.some(([sql]) => sql.startsWith('SELECT * FROM digital_development_sla_plans '))).toBe(false);
  });
});
