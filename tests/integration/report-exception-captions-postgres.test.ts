import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BUSINESS_TODO_CATEGORY_LABELS, businessExceptionDescription } from '@dx-rework/contracts/business-display';
import { exceptions } from '../../apps/api/src/reporting/management-reporting-exceptions.js';
import { exceptionReport } from '../../apps/api/src/reporting/management-reporting-report-exceptions.js';
import { ownedPostgresSchema } from '../helpers/owned-postgres-schema.js';
const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
(url ? describe : describe.skip)('exception business captions and exact record SQL', () => {
  const schema = ownedPostgresSchema('exception_captions');
  const admin = new pg.Pool({ connectionString: url! });
  const db = new pg.Pool({ connectionString: url!, options: `-c search_path=${schema}` });
  const orderId = randomUUID(), caseId = randomUUID(), deletedOrderId = randomUUID();
  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await db.query(`
      CREATE TABLE rework_orders(rework_order_id uuid,status text);
      CREATE TABLE rework_todos(todo_id uuid,entity_type text,entity_id text,category text,status text,due_at timestamptz,blocked_at timestamptz);
      CREATE TABLE rework_own_factory_approvals(approval_id uuid,rework_order_id uuid);
      CREATE TABLE rework_external_responsibility_cases(case_id uuid,rework_order_id uuid,supplier_name_snapshot text,status text);
      CREATE TABLE rework_responsibility_determinations(determination_id uuid,rework_order_id uuid);
      CREATE TABLE dingtalk_todo_external_bindings(binding_id uuid,todo_id uuid,provider_state text,updated_at timestamptz);
      CREATE TABLE rework_external_deduction_follow_ups(follow_up_id uuid,case_id uuid,next_follow_up_at timestamptz,created_at timestamptz);
    `);
    await db.query("INSERT INTO rework_orders VALUES($1,'completed'),($2,'deleted')", [orderId, deletedOrderId]);
    for (const category of [...Object.keys(BUSINESS_TODO_CATEGORY_LABELS), 'unknown_private_category']) {
      const todoId = randomUUID();
      await db.query("INSERT INTO rework_todos VALUES($1,'rework_order',$2,$3,'pending','2026-10-01T00:00:00Z',NULL)", [todoId, orderId, category]);
    }
    const failedId = randomUUID();
    await db.query("INSERT INTO rework_todos VALUES($1,'rework_order',$2,'external_deduction_follow_up','blocked_recipient',NULL,'2026-10-02T00:00:00Z'),($3,'rework_order',$4,'sourcing_finance_reconcile','pending','2026-10-01T00:00:00Z',NULL)", [failedId, orderId, randomUUID(), deletedOrderId]);
    await db.query("INSERT INTO dingtalk_todo_external_bindings VALUES($1,$2,'permanent_failed','2026-10-03T00:00:00Z')", [randomUUID(), failedId]);
    await db.query("INSERT INTO rework_external_responsibility_cases VALUES($1,$2,'TEST exact supplier','deduction_follow_up')", [caseId, orderId]);
    // Only the latest follow-up is an exception; older history must not duplicate it.
    await db.query("INSERT INTO rework_external_deduction_follow_ups VALUES($1,$3,'2026-10-01T00:00:00Z','2026-09-01T00:00:00Z'),($2,$3,'2026-10-02T00:00:00Z','2026-09-02T00:00:00Z')", [randomUUID(), randomUUID(), caseId]);
  });
  afterAll(async () => { await db.end(); await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); });
  it('finds every known displayed category before LIMIT and retains the unknown boundary', async () => {
    for (const [category, caption] of Object.entries(BUSINESS_TODO_CATEGORY_LABELS)) {
      const rows = await exceptions(1000, db, { q: `待办逾期：${caption}` });
      expect(rows.some(row => row.label === `待办逾期：${category}`), category).toBe(true);
    }
    expect(await exceptions(1, db, { q: '事项类别待核实' })).toMatchObject([{ label: '待办逾期：unknown_private_category' }]);
    const report = await exceptionReport(db, { q: '财务核对' }, { from: '2026-10-01', to: '2026-10-04' }, 15);
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]).toMatchObject({ label: '待办逾期：财务核对', reworkOrderId: orderId });
    expect(report.totals).toEqual({ exceptionCount: '1' });
  });
  it('searches the displayed type/description while preserving range, status, limits and bound text', async () => {
    expect(await exceptions(15, db, { q: '待办投递失败' })).toMatchObject([{ exceptionType: 'todo_delivery_failed' }]);
    const delivery = await exceptions(15, db, { q: '跟进供应商实际扣款', status: 'todo_delivery_failed' });
    expect(delivery).toHaveLength(1);
    expect(businessExceptionDescription(delivery[0]!.label)).toBe('钉钉投递永久失败：跟进供应商实际扣款');
    expect(await exceptions(15, db, { q: '待办投递失败', from: '2026-10-04' })).toEqual([]);
    expect(await exceptions(15, db, { q: '财务核对', status: 'blocked_recipient' })).toEqual([]);
    expect(await exceptions(15, db, { q: "' OR TRUE --" })).toEqual([]);
    expect(await exceptions(1, db, { q: '待办逾期' })).toHaveLength(1);
  });
  it('links the latest overdue deduction to its order and exact case, without a generic queue', async () => {
    const rows = await exceptions(15, db, { q: 'TEST exact supplier' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ reworkOrderId: orderId, deepLink: `/ui/tasks/${orderId}?node=settlement_followup&case=${caseId}` });
  });
});
