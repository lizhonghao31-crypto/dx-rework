import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AccessMasterDataService } from "../../apps/api/src/access/service.js";
import { ProcessConfigurationService } from "../../apps/api/src/rework/process-configuration-service.js";
import { ResponsibilityDeterminationService } from "../../apps/api/src/rework/responsibility-determination-service.js";
import { ReworkInitiationService } from "../../apps/api/src/rework/service.js";
import { WholeOrderReviewService } from "../../apps/api/src/rework/whole-order-review-service.js";
import { WorkReportingService } from "../../apps/api/src/rework/work-reporting-service.js";
import type { TrustedActorContext } from "../../apps/api/src/tools/repositories.js";

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const runWithPostgres = databaseUrl ? describe : describe.skip;
const migrationNames = [
  "0001_platform_foundation.sql",
  "0002_dingtalk_identity_access.sql",
  "0003_identity_union_continuity.sql",
  "0004_public_tools_foundation.sql",
  "0005_access_master_data.sql",
  "0006_rework_initiation.sql",
  "0007_process_configuration_ie_review.sql",
  "0008_worker_assignment_reporting.sql",
  "0009_whole_order_review_quantity_adjustment.sql",
  "0010_responsibility_determination_amount_engine.sql",
] as const;

runWithPostgres("responsibility PostgreSQL closure", () => {
  const schema = "responsibility_" + randomUUID().replaceAll("-", "");
  const admin = new pg.Pool({ connectionString: databaseUrl! });
  const database = new pg.Pool({
    connectionString: databaseUrl!,
    options: "-c search_path=" + schema,
  });
  const access = new AccessMasterDataService(database, "corp");
  const initiation = new ReworkInitiationService(database, "corp");
  const configuration = new ProcessConfigurationService(database);
  const reporting = new WorkReportingService(database);
  const review = new WholeOrderReviewService(database);
  const responsibility = new ResponsibilityDeterminationService(database);
  const ids = {
    admin: randomUUID(),
    owner: randomUUID(),
    qc: randomUUID(),
    tail: randomUUID(),
    ie: randomUUID(),
    merch: randomUUID(),
    worker: randomUUID(),
    production: randomUUID(),
  };
  const actor = (
    id: string,
    roles: readonly string[],
    capability: string,
  ): TrustedActorContext => ({
    actorId: id,
    actorRoles: roles,
    authorizationCapability: capability,
    authorizationCapabilities: [capability],
    requestId: randomUUID(),
  });
  let business:
    | {
        orderId: string;
        itemId: string;
        orderVersion: number;
        draftVersion: number;
        draftId: string;
        amountLines: number;
      }
    | undefined;

  beforeAll(async () => {
    await admin.query("CREATE SCHEMA " + schema);
    for (const migration of migrationNames) {
      await database.query(
        await readFile(
          new URL("../../apps/api/migrations/" + migration, import.meta.url),
          "utf8",
        ),
      );
    }
    for (const [id, name, role] of [
      [ids.admin, "Admin", "system_admin"],
      [ids.owner, "Owner", "owner_group"],
      [ids.qc, "QC", "quality_control"],
      [ids.tail, "Tail", "tail_supervisor"],
      [ids.ie, "IE", "ie_reviewer"],
      [ids.merch, "Merch", "order_merchandiser"],
      [ids.worker, "Worker", "worker"],
      [ids.production, "Production", "production_management"],
    ] as const) {
      await database.query(
        "INSERT INTO app_users(id,display_name) VALUES($1,$2)",
        [id, name],
      );
      await database.query(
        "INSERT INTO identity_mappings(id,user_id,provider,corp_id,provider_user_id,union_id,active,employed,last_verified_at) VALUES($1,$2,'dingtalk','corp',$3,$4,true,true,CURRENT_TIMESTAMP)",
        [randomUUID(), id, "ding-" + id, "union-" + id],
      );
      await database.query(
        "INSERT INTO user_role_assignments(assignment_id,user_id,role_code,granted_by,grant_reason) VALUES($1,$2,$3,$2,'fixture')",
        [randomUUID(), id, role],
      );
    }
    await access.ensureOrganizationPolicy();
    const person = (
      await access.createPerson(
        actor(ids.admin, ["system_admin"], "master_data:manage"),
        {
          personType: "internal",
          appUserId: ids.worker,
          displayName: "Worker",
          aliases: [],
          reason: "S1 fixture",
        },
      )
    ).personId;
    const created = await initiation.createDraft(
      actor(ids.qc, ["quality_control"], "rework:initiate"),
      {
        styleNo: "S1",
        merchandiserUserId: ids.merch,
        processingFactory: { type: "own_factory" },
        problemPart: "袖口",
        problemDescription: "S1",
        reworkQuantity: 1,
      },
      randomUUID(),
    );
    const submitted = await initiation.submit(
      actor(ids.qc, ["quality_control"], "rework:initiate"),
      created.value.reworkOrderId,
      { expectedVersion: created.value.version },
      randomUUID(),
    );
    const saved = await configuration.saveDraft(
      actor(ids.tail, ["tail_supervisor"], "process:configure"),
      created.value.reworkOrderId,
      {
        expectedOrderVersion: submitted.value.version,
        items: [
          {
            source: "custom",
            customProcessName: "S1 process",
            pricingUnit: "piece",
            plannedQuantity: 1,
            unitPrice: 1,
          },
        ],
      },
      randomUUID(),
    );
    const queued = await configuration.submit(
      actor(ids.tail, ["tail_supervisor"], "process:configure"),
      created.value.reworkOrderId,
      {
        expectedOrderVersion: saved.value.orderVersion,
        expectedConfigurationVersion:
          saved.value.configuration!.configurationVersion,
      },
      randomUUID(),
    );
    const approved = await configuration.review(
      actor(ids.ie, ["ie_reviewer"], "process:review"),
      created.value.reworkOrderId,
      {
        expectedOrderVersion: queued.value.orderVersion,
        expectedConfigurationVersion:
          queued.value.configuration!.configurationVersion,
        decision: "approved",
      },
      randomUUID(),
    );
    const itemId = approved.value.configuration!.items[0]!.configurationItemId;
    const task = await reporting.createTask(
      actor(ids.tail, ["tail_supervisor"], "work:assign"),
      created.value.reworkOrderId,
      {
        expectedOrderVersion: approved.value.orderVersion,
        configurationItemId: itemId,
        mode: "individual",
        members: [{ personId: person }],
      },
      randomUUID(),
    );
    const listed = await reporting.list(
      actor(ids.tail, ["tail_supervisor"], "work:assign"),
      created.value.reworkOrderId,
    );
    await reporting.submitReport(
      actor(ids.worker, ["worker"], "work:report"),
      task.value.workTaskId,
      {
        expectedOrderVersion: listed.orderVersion,
        actualQuantity: 1,
        completedAt: new Date().toISOString(),
      },
      randomUUID(),
    );
    const reviewView = await review.get(
      actor(ids.tail, ["tail_supervisor"], "submission:audit"),
      created.value.reworkOrderId,
    );
    const reviewed = await review.approve(
      actor(ids.tail, ["tail_supervisor"], "submission:audit"),
      created.value.reworkOrderId,
      { expectedOrderVersion: reviewView.orderVersion },
      randomUUID(),
    );
    business = {
      orderId: created.value.reworkOrderId,
      itemId,
      orderVersion: reviewed.value.orderVersion,
      draftVersion: 0,
      draftId: "",
      amountLines: 0,
    };
  });
  afterAll(async () => {
    await database.end();
    await admin.query("DROP SCHEMA IF EXISTS " + schema + " CASCADE");
    await admin.end();
  });

  it("replays 0010 and creates all six immutable responsibility tables", async () => {
    const result = await database.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema=$1 AND table_name LIKE 'rework_responsibility_%' ORDER BY table_name`,
      [schema],
    );
    expect(result.rows.map((row) => row.table_name)).toEqual([
      "rework_responsibility_allocations",
      "rework_responsibility_amount_lines",
      "rework_responsibility_determinations",
      "rework_responsibility_handler_events",
      "rework_responsibility_high_multiplier_confirmations",
      "rework_responsibility_processes",
    ]);
  });

  it("stores genuine scale-15 unrounded amounts and binds finalized confirmations", async () => {
    const columns = await database.query<{
      column_name: string;
      numeric_scale: number | null;
    }>(
      `SELECT column_name,numeric_scale FROM information_schema.columns WHERE table_schema=$1 AND table_name='rework_responsibility_amount_lines' AND column_name='unrounded_amount'`,
      [schema],
    );
    expect(columns.rows).toEqual([
      { column_name: "unrounded_amount", numeric_scale: 15 },
    ]);
    const fk = await database.query(
      `SELECT 1 FROM pg_constraint WHERE connamespace=$1::regnamespace AND conname='responsibility_source_confirmation_fk'`,
      [schema],
    );
    expect(fk.rowCount).toBe(1);
  });

  it("uses deferred closure triggers on every version component", async () => {
    const triggers = await database.query<{ table_name: string }>(
      `SELECT c.relname table_name FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND t.tgname IN ('determination_complete','process_complete','allocation_complete','amount_line_complete') AND t.tgdeferrable AND t.tginitdeferred ORDER BY c.relname`,
      [schema],
    );
    expect(triggers.rows.map((row) => row.table_name)).toEqual([
      "rework_responsibility_allocations",
      "rework_responsibility_amount_lines",
      "rework_responsibility_determinations",
      "rework_responsibility_processes",
    ]);
  });

  it("rejects forbidden responsibility delegation scopes without changing other capabilities", async () => {
    const guard = await database.query<{ definition: string }>(
      "SELECT pg_get_functiondef($1::regprocedure) definition",
      ["guard_responsibility_delegation_scope()"],
    );
    expect(guard.rows[0]?.definition).toContain("scope_type<>'rework_order'");
    expect(guard.rows[0]?.definition).toContain(
      "responsibility:confirm_high_multiplier",
    );
  });

  it("requires exact action capability and trusted transaction context", async () => {
    const guard = await database.query<{ definition: string }>(
      "SELECT pg_get_functiondef($1::regprocedure) definition",
      ["require_responsibility_event(uuid,text,uuid,uuid)"],
    );
    expect(guard.rows[0]?.definition).toContain(
      "dx_rework.responsibility_event_id",
    );
    expect(guard.rows[0]?.definition).toContain(
      "responsibility_expected_capability",
    );
  });

  it("saveDraft keeps the state, increments the order once, and persists complete amount lines", async () => {
    const b = business!;
    const who = actor(
      ids.production,
      ["production_management"],
      "responsibility:determine",
    );
    const result = await responsibility.saveDraft(
      who,
      b.orderId,
      {
        expectedOrderVersion: b.orderVersion,
        expectedCurrentDeterminationVersion: null,
        handlerUserId: ids.production,
        reason: null,
        processes: [
          {
            configurationItemId: b.itemId,
            multiplier: "1.000",
            highMultiplierReason: null,
            allocations: [
              { responsibilityType: "own_factory", shareBps: 10000 },
            ],
          },
        ],
      },
      "s1-draft",
    );
    expect(result.value).toMatchObject({
      reworkStatus: "pending_responsibility_determination",
      orderVersion: b.orderVersion + 1,
      determination: { stage: "draft", version: 1 },
    });
    const row = await database.query<{
      determination_id: string;
      count: number;
    }>(
      `SELECT d.determination_id,count(l.*)::int count FROM rework_responsibility_determinations d JOIN rework_responsibility_amount_lines l USING(determination_id) WHERE d.rework_order_id=$1 GROUP BY d.determination_id`,
      [b.orderId],
    );
    expect(row.rows[0]!.count).toBeGreaterThan(0);
    b.orderVersion++;
    b.draftVersion = 1;
    b.draftId = row.rows[0]!.determination_id;
    b.amountLines = row.rows[0]!.count;
  });

  it("finalize advances state and creates a finalized successor", async () => {
    const b = business!;
    const finalizeSql: string[] = [];
    const proxyPool = {
      connect: async () => {
        const client = await database.connect();
        return new Proxy(client, {
          get(target, property) {
            if (property === "query")
              return (text: string, values?: readonly unknown[]) => {
                finalizeSql.push(text);
                return target.query(text, values as never);
              };
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      },
    } as unknown as pg.Pool;
    const finalizeService = new ResponsibilityDeterminationService(proxyPool);
    const result = await finalizeService.finalize(
      actor(
        ids.production,
        ["production_management"],
        "responsibility:determine",
      ),
      b.orderId,
      {
        expectedOrderVersion: b.orderVersion,
        expectedCurrentDeterminationVersion: b.draftVersion,
      },
      "s1-finalize",
    );
    const copyIndex = finalizeSql.findIndex((sql) =>
      /INSERT INTO\s+rework_responsibility_processes\s+SELECT/.test(sql),
    );
    expect(copyIndex).toBeGreaterThan(0);
    expect(
      finalizeSql
        .slice(0, copyIndex)
        .filter((sql) =>
          /rework_work_reports|rework_work_report_member_shares/.test(sql),
        ),
    ).toEqual([]);
    expect(result.value).toMatchObject({
      reworkStatus: "pending_responsibility_action",
      orderVersion: b.orderVersion + 1,
      determination: { stage: "finalized", version: 2 },
    });
    b.orderVersion++;
  });

  it("finalize copies every child row and does not query live work-report sources", async () => {
    const b = business!;
    const roots = await database.query<{
      determination_id: string;
      replaces_determination_id: string | null;
    }>(
      "SELECT determination_id,replaces_determination_id FROM rework_responsibility_determinations WHERE rework_order_id=$1 ORDER BY determination_version",
      [b.orderId],
    );
    const finalId = roots.rows[1]!.determination_id;
    for (const table of [
      "rework_responsibility_processes",
      "rework_responsibility_allocations",
      "rework_responsibility_amount_lines",
    ]) {
      const counts = await database.query<{ draft: number; finalized: number }>(
        `SELECT count(*) FILTER(WHERE determination_id=$1)::int draft,count(*) FILTER(WHERE determination_id=$2)::int finalized FROM ${table}`,
        [b.draftId, finalId],
      );
      expect(counts.rows[0]).toEqual({
        draft: table.endsWith("amount_lines") ? b.amountLines : 1,
        finalized: table.endsWith("amount_lines") ? b.amountLines : 1,
      });
    }
    const event = await database.query<{
      before_state: Record<string, unknown>;
      after_state: Record<string, unknown>;
    }>(
      "SELECT before_state,after_state FROM operation_events WHERE entity_id=$1 AND action='rework.responsibility.finalize'",
      [b.orderId],
    );
    expect(event.rows[0]!.before_state).toMatchObject({
      status: "pending_responsibility_determination",
      version: b.orderVersion - 1,
    });
    expect(event.rows[0]!.after_state).toMatchObject({
      status: "pending_responsibility_action",
      version: b.orderVersion,
    });
  });

  it("replays draft/finalize idempotently and rejects unaudited direct order writes", async () => {
    const b = business!;
    const who = actor(
      ids.production,
      ["production_management"],
      "responsibility:determine",
    );
    const before = await database.query<{
      roots: number;
      lines: number;
      version: number;
    }>(
      `SELECT (SELECT count(*)::int FROM rework_responsibility_determinations WHERE rework_order_id=$1) roots,(SELECT count(*)::int FROM rework_responsibility_amount_lines l JOIN rework_responsibility_determinations d USING(determination_id) WHERE d.rework_order_id=$1) lines,(SELECT version FROM rework_orders WHERE rework_order_id=$1) version`,
      [b.orderId],
    );
    const draftReplay = await responsibility.saveDraft(
      who,
      b.orderId,
      {
        expectedOrderVersion: b.orderVersion - 2,
        expectedCurrentDeterminationVersion: null,
        handlerUserId: ids.production,
        reason: null,
        processes: [
          {
            configurationItemId: b.itemId,
            multiplier: "1.000",
            highMultiplierReason: null,
            allocations: [
              { responsibilityType: "own_factory", shareBps: 10000 },
            ],
          },
        ],
      },
      "s1-draft",
    );
    expect(draftReplay.reused).toBe(true);
    const finalReplay = await responsibility.finalize(
      who,
      b.orderId,
      {
        expectedOrderVersion: b.orderVersion - 1,
        expectedCurrentDeterminationVersion: 1,
      },
      "s1-finalize",
    );
    expect(finalReplay.reused).toBe(true);
    const after = await database.query(
      `SELECT (SELECT count(*)::int FROM rework_responsibility_determinations WHERE rework_order_id=$1) roots,(SELECT count(*)::int FROM rework_responsibility_amount_lines l JOIN rework_responsibility_determinations d USING(determination_id) WHERE d.rework_order_id=$1) lines,(SELECT version FROM rework_orders WHERE rework_order_id=$1) version`,
      [b.orderId],
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
    await expect(
      database.query(
        "UPDATE rework_orders SET version=version+1 WHERE rework_order_id=$1",
        [b.orderId],
      ),
    ).rejects.toThrow(/audit context/);
  });
});
