import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";

type Database = Pick<PoolClient, "query">;
type FixtureOptions = {
  source?: string;
  bearer?: string;
  stage?: string;
  schemaVersion?: number;
  deleted?: boolean;
  waived?: boolean;
  superseded?: boolean;
  existingTail?: boolean;
  uplift?: boolean;
  missingWages?: boolean;
};

// Reconstruct the pre-0165 omission in an isolated schema. The fixture owns
// these test tables, so it disables only user-defined business triggers while
// seeding historical rows. PostgreSQL system/constraint triggers stay enabled,
// and all business triggers are restored before the migration/assertions run.
const HISTORY_FIXTURE_TABLES = [
  "app_users",
  "rework_orders",
  "operation_events",
  "rework_process_configurations",
  "rework_order_reviews",
  "rework_wage_periods",
  "rework_responsibility_determinations",
  "rework_process_configuration_items",
  "rework_responsibility_processes",
  "rework_responsibility_allocations",
  "business_people",
  "rework_work_tasks",
  "rework_work_reports",
  "rework_work_report_member_shares",
  "rework_wage_items",
  "rework_responsibility_amount_lines",
] as const;

const setHistoryFixtureTriggers = async (db: Database, enabled: boolean) => {
  for (const table of HISTORY_FIXTURE_TABLES) {
    await db.query(`ALTER TABLE ${table} ${enabled ? "ENABLE" : "DISABLE"} TRIGGER USER`);
  }
};

export async function seedOwnTailHistory(db: Database, options: FixtureOptions = {}) {
  const actor = randomUUID(), order = randomUUID(), configuration = randomUUID();
  const review = randomUUID(), event = randomUUID();
  let determination = randomUUID();
  let predecessor: string | null = null;
  const period = (await db.query("SELECT period_id FROM rework_wage_periods LIMIT 1")).rows[0]?.period_id ?? randomUUID(), request = `TEST-tail-${randomUUID()}`;
  const input = { fixture: "pre-0165 own-tail omission", untouched: true };
  const insert = async (table: string, fields: Record<string, unknown>) => {
    const columns = Object.keys(fields);
    await db.query(`INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(",")})`, Object.values(fields));
  };
  await db.query("BEGIN");
  try {
    await setHistoryFixtureTriggers(db, false);
    await insert("app_users", { id: actor, display_name: "TEST history actor", enabled: true });
    await insert("rework_orders", {
      rework_order_id: order, created_by: actor, updated_by: actor,
      status: options.deleted ? "deleted" : "completed", style_no: "TEST-BO20547249",
      tail_inspection_required: !options.waived,
      tail_inspection_cost_bearer: options.waived ? null : (options.bearer ?? "own_factory"),
      tail_inspection_cost_bearer_source: options.waived ? null : (options.source ?? "production_override"),
      ...(options.deleted ? { deleted_at: new Date(), deleted_by: actor } : {}),
    });
    await insert("operation_events", {
      event_id: event, request_id: request, actor_id: actor, actor_roles: ["production_supervisor"],
      authorization_capability: "responsibility:determine", action: "rework.responsibility.finalize",
      entity_type: "rework_order", entity_id: order,
    });
    await insert("rework_process_configurations", {
      configuration_id: configuration, rework_order_id: order, configuration_version: 1,
      configuration_kind: "initial", status: "approved", created_by: actor,
      reviewed_by: actor, reviewed_at: new Date(),
    });
    await insert("rework_order_reviews", { order_review_id: review, rework_order_id: order, reviewed_by: actor, review_snapshot: "{}" });
    if (!(await db.query("SELECT 1 FROM rework_wage_periods WHERE period_id=$1", [period])).rowCount) await insert("rework_wage_periods", {
      period_id: period, period_month: "2026-08-01", status: "ready_to_lock",
      created_operation_event_id: event, created_request_id: request,
    });
    await insert("rework_responsibility_determinations", {
      determination_id: determination, rework_order_id: order, determination_version: 1,
      source_order_review_id: review, stage: options.stage ?? "finalized", handler_user_id: actor,
      created_by: actor, input_snapshot: JSON.stringify(input), calculation_total: options.existingTail ? "1956.05" : "1551.35",
      operation_event_id: event, request_id: request, settlement_schema_version: options.schemaVersion ?? 2,
    });
    const wageIds: string[] = [];
    const tailIds: string[] = [];
    for (const [index, price, quantities] of [[1, "1.15", [1349]], [2, "0.30", [725, 624]]] as const) {
      const item = randomUUID();
      if (index === 2) tailIds.push(item);
      const name = index === 1 ? "TEST 普通返工" : "TEST 整查";
      await insert("rework_process_configuration_items", {
        configuration_item_id: item, configuration_id: configuration, position: index,
        source: "custom", custom_process_name: name, process_name: name, pricing_unit: "piece",
        planned_quantity: 1349, unit_price: price, execution_kind: index === 1 ? "worker" : "tail_inspection",
      });
      const include = index === 1 || options.existingTail;
      if (include) {
        const amount = index === 1 ? "1551.35" : "404.70";
        await insert("rework_responsibility_processes", {
          determination_id: determination, configuration_item_id: item, process_name_snapshot: name,
          pricing_unit_snapshot: "piece", multiplier: "1.000", base_amount: amount,
          responsibility_amount: amount, operation_event_id: event, request_id: request,
        });
        await insert("rework_responsibility_allocations", {
          determination_id: determination, configuration_item_id: item, responsibility_type: "own_factory",
          share_bps: 10000, multiplier: "1.000", rounded_amount: amount, operation_event_id: event, request_id: request,
        });
      }
      for (const quantity of quantities) {
        const person = randomUUID(), task = randomUUID(), report = randomUUID(), wage = randomUUID();
        const base = (quantity * Number(price)).toFixed(2);
        const payable = options.uplift && index === 2 ? (Number(base) * 1.2).toFixed(2) : base;
        await insert("business_people", {
          person_id: person, person_type: "temporary", display_name: "TEST worker",
          temporary_code: `TMP-${person.replaceAll("-", "").slice(0, 8).toUpperCase()}`, created_by: actor,
        });
        await insert("rework_work_tasks", {
          work_task_id: task, rework_order_id: order, configuration_item_id: item,
          task_version: quantity, assignment_mode: "individual", created_by: actor,
        });
        await insert("rework_work_reports", {
          work_report_id: report, work_task_id: task, rework_order_id: order,
          configuration_item_id: item, actual_quantity: quantity, completed_at: new Date(),
          group_amount: payable, submitted_by: actor,
        });
        await insert("rework_work_report_member_shares", { work_report_id: report, person_id: person, amount: payable });
        if (!(index === 2 && options.missingWages)) {
          wageIds.push(wage);
          await insert("rework_wage_items", {
            wage_item_id: wage, period_id: period, order_review_id: review, rework_order_id: order,
            configuration_item_id: item, work_task_id: task, work_report_id: report, person_id: person,
            person_name_snapshot: "TEST worker", person_type_snapshot: "temporary",
            rework_no_snapshot: "TEST-RW-2026-0826-004", style_no_snapshot: "TEST-BO20547249",
            process_name_snapshot: name, pricing_unit_snapshot: "piece", unit_price_snapshot: price,
            actual_quantity_snapshot: quantity, assignment_mode: "individual", group_amount: payable,
            exact_person_share: payable, payable_amount: payable, fractional_remainder: 0,
            remainder_rank: 1, member_count: 1, member_snapshot: "[]", source_report_snapshot: "{}",
            operation_event_id: event, operation_request_id: request,
          });
        }
        if (include) await insert("rework_responsibility_amount_lines", {
          determination_id: determination, configuration_item_id: item, work_report_id: report, person_id: person,
          responsibility_type: "own_factory", base_member_share_amount: base, multiplier: "1.000",
          share_bps: 10000, unrounded_amount: base, rounded_amount: base, rounding_rule: "half_up_2",
          worker_display_name_snapshot: "TEST worker", task_mode_snapshot: "individual",
          member_snapshot: "[]", report_snapshot: "{}", operation_event_id: event, request_id: request,
        });
      }
    }
    if (options.superseded) {
      predecessor = determination;
      determination = randomUUID();
      await db.query(`INSERT INTO rework_responsibility_determinations
        SELECT (jsonb_populate_record(NULL::rework_responsibility_determinations,
          to_jsonb(d) || jsonb_build_object('determination_id',$2::text,
            'determination_version',2,'replaces_determination_id',$1::text))).*
        FROM rework_responsibility_determinations d WHERE determination_id=$1::uuid`, [predecessor, determination]);
      for (const table of ["rework_responsibility_processes", "rework_responsibility_allocations", "rework_responsibility_amount_lines"]) {
        await db.query(`INSERT INTO ${table}
          SELECT (jsonb_populate_record(NULL::${table},to_jsonb(t) || jsonb_build_object('determination_id',$2::text))).*
          FROM ${table} t WHERE determination_id=$1::uuid`, [predecessor, determination]);
      }
    }
    await setHistoryFixtureTriggers(db, true);
    await db.query("COMMIT");
    return { order, determination, predecessor, event, wageIds, tailIds, input };
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  }
}

export async function verifyOwnTailHistory(db: Database, migration: string) {
  const repaired = await seedOwnTailHistory(db);
  const draft = await seedOwnTailHistory(db, { stage: "draft", source: "quality_inspection" });
  const superseded = await seedOwnTailHistory(db, { superseded: true });
  const uplift = await seedOwnTailHistory(db, { uplift: true });
  const existing = await seedOwnTailHistory(db, { existingTail: true });
  const excluded = [];
  for (const options of [
    { source: "legacy_default" }, { bearer: "processing_factory" },
    { schemaVersion: 1 }, { deleted: true }, { waived: true },
  ]) excluded.push(await seedOwnTailHistory(db, options));
  const beforeWages = (await db.query("SELECT to_jsonb(w) AS value FROM rework_wage_items w ORDER BY wage_item_id")).rows;
  const beforeEvents = (await db.query("SELECT to_jsonb(e) AS value FROM operation_events e ORDER BY event_id")).rows;
  await db.query("BEGIN");
  try { await db.query(migration); await db.query("COMMIT"); }
  catch (error) { await db.query("ROLLBACK"); throw error; }
  for (const fixture of [repaired, draft, uplift, superseded]) {
    const { rows: [row] } = await db.query(`SELECT d.calculation_total::text, d.input_snapshot,
      c.original_calculation_total::text, c.added_responsibility_amount::text,
      c.corrected_calculation_total::text, c.source_snapshot
      FROM rework_responsibility_determinations d JOIN rework_own_tail_responsibility_corrections c USING(determination_id)
      WHERE d.determination_id=$1`, [fixture.determination]);
    assert.equal(row?.calculation_total, "1956.05");
    assert.equal(row.original_calculation_total, "1551.35");
    assert.equal(row.added_responsibility_amount, "404.70");
    assert.equal(row.corrected_calculation_total, "1956.05");
    assert.deepEqual(row.input_snapshot, fixture.input);
    assert.equal(row.source_snapshot[0].wageSources.length, 2);
    const { rows: [totals] } = await db.query(`SELECT
      sum(rounded_amount) FILTER (WHERE responsibility_type='own_factory')::text AS own,
      coalesce(sum(rounded_amount) FILTER (WHERE responsibility_type<>'own_factory'),0)::text AS external
      FROM rework_responsibility_allocations WHERE determination_id=$1`, [fixture.determination]);
    assert.equal(totals.own, "1956.05");
    assert.equal(Number(totals.external), 0);
  }
  for (const fixture of [...excluded, existing]) {
    assert.equal((await db.query("SELECT count(*)::int count FROM rework_own_tail_responsibility_corrections WHERE determination_id=$1", [fixture.determination])).rows[0].count, 0);
  }
  assert.equal((await db.query("SELECT calculation_total::text FROM rework_responsibility_determinations WHERE determination_id=$1", [superseded.predecessor])).rows[0].calculation_total, "1551.35");
  assert.deepEqual((await db.query("SELECT to_jsonb(w) AS value FROM rework_wage_items w ORDER BY wage_item_id")).rows, beforeWages);
  assert.deepEqual((await db.query("SELECT to_jsonb(e) AS value FROM operation_events e ORDER BY event_id")).rows, beforeEvents);
  // Replay the repair transaction (not DDL) to prove no duplicate postings.
  await db.query("BEGIN");
  await db.query(migration.slice(migration.indexOf("LOCK TABLE")));
  await db.query("COMMIT");
  assert.equal((await db.query("SELECT count(*)::int count FROM rework_own_tail_responsibility_corrections")).rows[0].count, 4);
  await assert.rejects(db.query("UPDATE rework_own_tail_responsibility_corrections SET reason='changed'"), /append.only|immutable|mutation/i);
  await assert.rejects(db.query("UPDATE rework_responsibility_determinations SET calculation_total=0 WHERE determination_id=$1", [repaired.determination]), /append.only|immutable|mutation/i);
  const incomplete = await seedOwnTailHistory(db, { missingWages: true });
  await db.query("BEGIN");
  await assert.rejects(db.query(migration.slice(migration.indexOf("LOCK TABLE"))), /missing reviewed tail wage sources/);
  await db.query("ROLLBACK");
  assert.equal((await db.query("SELECT calculation_total::text FROM rework_responsibility_determinations WHERE determination_id=$1", [incomplete.determination])).rows[0].calculation_total, "1551.35");
}
