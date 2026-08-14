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

import { completeInspectionReport } from "../inspection-report-fixture.js";

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const runWithPostgres = databaseUrl ? describe : describe.skip;
const migrations = [
  "0001_platform_foundation.sql",
  "0002_dingtalk_identity_access.sql",
  "0003_identity_union_continuity.sql",
  "0004_public_tools_foundation.sql",
  "0005_access_master_data.sql",
  "0006_rework_initiation.sql",
  "0056_n01_digital_inspection_report.sql",
  "0007_process_configuration_ie_review.sql",
  "0008_worker_assignment_reporting.sql",
  "0009_whole_order_review_quantity_adjustment.sql",
  "0010_responsibility_determination_amount_engine.sql",
  "0011_responsibility_authorization_handler_closure.sql",
  "0012_responsibility_direct_delegation.sql",
  "0013_responsibility_review_closure.sql",
] as const;

type ReviewedOrder = {
  orderId: string;
  itemId: string;
  orderVersion: number;
};

runWithPostgres("responsibility Codex-review closure", () => {
  const schema = "responsibility_review_" + randomUUID().replaceAll("-", "");
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
    production: randomUUID(),
    qc: randomUUID(),
    tail: randomUUID(),
    ie: randomUUID(),
    merch: randomUUID(),
    workerOne: randomUUID(),
    workerTwo: randomUUID(),
  };
  let workerOnePerson = "";
  let workerTwoPerson = "";

  const actor = (
    actorId: string,
    actorRoles: readonly string[],
    authorizationCapability: string,
  ): TrustedActorContext => ({
    actorId,
    actorRoles,
    authorizationCapability,
    authorizationCapabilities: [authorizationCapability],
    requestId: randomUUID(),
  });

  async function createReviewedOrder(
    label: string,
    mode: "individual" | "collective",
  ): Promise<ReviewedOrder> {
    const created = await initiation.createDraft(
      actor(ids.qc, ["quality_control"], "rework:initiate"),
      {
        styleNo: "REVIEW-" + label,
        merchandiserUserId: ids.merch,
        processingFactory: { type: "own_factory" },
        problemPart: "袖口",
        problemDescription: "review closure " + label,
        reworkQuantity: 1,
        inspectionReport: completeInspectionReport(),
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
            customProcessName: "review process " + label,
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
        mode,
        members:
          mode === "collective"
            ? [{ personId: workerOnePerson }, { personId: workerTwoPerson }]
            : [{ personId: workerOnePerson }],
      },
      randomUUID(),
    );
    const listed = await reporting.list(
      actor(ids.tail, ["tail_supervisor"], "work:assign"),
      created.value.reworkOrderId,
    );
    await reporting.submitReport(
      actor(ids.workerOne, ["worker"], "work:report"),
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
    return {
      orderId: created.value.reworkOrderId,
      itemId,
      orderVersion: reviewed.value.orderVersion,
    };
  }

  beforeAll(async () => {
    await admin.query("CREATE SCHEMA " + schema);
    for (const migration of migrations) {
      await database.query(
        await readFile(
          new URL("../../apps/api/migrations/" + migration, import.meta.url),
          "utf8",
        ),
      );
    }

    for (const [userId, displayName, role] of [
      [ids.admin, "Admin", "system_admin"],
      [ids.production, "Production", "production_management"],
      [ids.qc, "QC", "quality_control"],
      [ids.tail, "Tail", "tail_supervisor"],
      [ids.ie, "IE", "ie_reviewer"],
      [ids.merch, "Merch", "order_merchandiser"],
      [ids.workerOne, "Worker One", "worker"],
      [ids.workerTwo, "Worker Two", "worker"],
    ] as const) {
      await database.query(
        "INSERT INTO app_users(id,display_name) VALUES($1,$2)",
        [userId, displayName],
      );
      await database.query(
        `INSERT INTO identity_mappings(
           id,user_id,provider,corp_id,provider_user_id,union_id,
           active,employed,last_verified_at
         ) VALUES($1,$2,'dingtalk','corp',$3,$4,true,true,CURRENT_TIMESTAMP)`,
        [randomUUID(), userId, "ding-" + userId, "union-" + userId],
      );
      await database.query(
        `INSERT INTO user_role_assignments(
           assignment_id,user_id,role_code,granted_by,grant_reason
         ) VALUES($1,$2,$3,$2,'fixture')`,
        [randomUUID(), userId, role],
      );
    }

    await access.ensureOrganizationPolicy();
    workerOnePerson = (
      await access.createPerson(
        actor(ids.admin, ["system_admin"], "master_data:manage"),
        {
          personType: "internal",
          appUserId: ids.workerOne,
          displayName: "Worker One",
          aliases: [],
          reason: "review fixture",
        },
      )
    ).personId;
    workerTwoPerson = (
      await access.createPerson(
        actor(ids.admin, ["system_admin"], "master_data:manage"),
        {
          personType: "internal",
          appUserId: ids.workerTwo,
          displayName: "Worker Two",
          aliases: [],
          reason: "review fixture",
        },
      )
    ).personId;
  });

  afterAll(async () => {
    await database.end();
    await admin.query("DROP SCHEMA IF EXISTS " + schema + " CASCADE");
    await admin.end();
  });

  it("counts equal collective shares separately and permits zero-cent lines", async () => {
    const order = await createReviewedOrder("collective-zero", "collective");
    const result = await responsibility.saveDraft(
      actor(
        ids.production,
        ["production_management"],
        "responsibility:determine",
      ),
      order.orderId,
      {
        expectedOrderVersion: order.orderVersion,
        expectedCurrentDeterminationVersion: null,
        handlerUserId: ids.production,
        processes: [
          {
            configurationItemId: order.itemId,
            multiplier: "1.000",
            allocations: [
              { responsibilityType: "own_factory", shareBps: 1 },
              { responsibilityType: "processing_factory", shareBps: 9999 },
            ],
          },
        ],
      },
      "review-collective-zero",
    );

    expect(result.value.determination).toMatchObject({
      stage: "draft",
      calculationTotal: "1.00",
      processes: [
        {
          baseAmount: "1.00000000",
          responsibilityAmount: "1.00",
        },
      ],
    });
    const lines = await database.query<{
      base_member_share_amount: string;
      rounded_amount: string;
    }>(
      `SELECT base_member_share_amount::text,rounded_amount::text
       FROM rework_responsibility_amount_lines
       WHERE determination_id=$1
       ORDER BY responsibility_type,person_id`,
      [result.value.determination!.determinationId],
    );
    expect(lines.rows).toHaveLength(4);
    expect(
      lines.rows.filter((row) => row.base_member_share_amount === "0.50000000"),
    ).toHaveLength(4);
    expect(
      lines.rows.filter((row) => row.rounded_amount === "0.00"),
    ).toHaveLength(2);
  });

  it("rejects amount-line multiplier and share values that differ from parents", async () => {
    const order = await createReviewedOrder("parent-binding", "individual");
    const saved = await responsibility.saveDraft(
      actor(
        ids.production,
        ["production_management"],
        "responsibility:determine",
      ),
      order.orderId,
      {
        expectedOrderVersion: order.orderVersion,
        expectedCurrentDeterminationVersion: null,
        handlerUserId: ids.production,
        processes: [
          {
            configurationItemId: order.itemId,
            multiplier: "1.000",
            allocations: [
              { responsibilityType: "own_factory", shareBps: 10000 },
            ],
          },
        ],
      },
      "review-parent-draft",
    );
    const determinationId = saved.value.determination!.determinationId;
    const source = await database.query<{
      work_report_id: string;
      person_id: string;
      base_member_share_amount: string;
      worker_display_name_snapshot: string;
      task_mode_snapshot: string;
      member_snapshot: unknown;
      report_snapshot: unknown;
      operation_event_id: string;
      request_id: string;
    }>(
      `SELECT work_report_id,person_id,base_member_share_amount::text,
              worker_display_name_snapshot,task_mode_snapshot,
              member_snapshot,report_snapshot,operation_event_id,request_id
       FROM rework_responsibility_amount_lines
       WHERE determination_id=$1
       LIMIT 1`,
      [determinationId],
    );
    const row = source.rows[0]!;

    const attempt = async (multiplier: string, shareBps: number) => {
      const client = await database.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `SELECT set_config('dx_rework.responsibility_event_id',$1,true),
                  set_config('dx_rework.responsibility_request_id',$2,true)`,
          [row.operation_event_id, row.request_id],
        );
        await client.query(
          `INSERT INTO rework_responsibility_allocations(
             determination_id,configuration_item_id,responsibility_type,
             share_bps,rounded_amount,operation_event_id,request_id
           ) VALUES($1,$2,'processing_factory',1,0,$3,$4)`,
          [
            determinationId,
            order.itemId,
            row.operation_event_id,
            row.request_id,
          ],
        );
        await expect(
          client.query(
            `INSERT INTO rework_responsibility_amount_lines(
               determination_id,configuration_item_id,work_report_id,person_id,
               responsibility_type,base_member_share_amount,multiplier,share_bps,
               unrounded_amount,rounded_amount,rounding_rule,
               worker_display_name_snapshot,task_mode_snapshot,member_snapshot,
               report_snapshot,operation_event_id,request_id
             ) VALUES(
               $1,$2,$3,$4,'processing_factory',$5,$6,$7,
               round($5::numeric*$6::numeric*$7::integer/10000,15),
               round(round($5::numeric*$6::numeric*$7::integer/10000,15),2),
               'half_up_2',$8,$9,$10,$11,$12,$13
             )`,
            [
              determinationId,
              order.itemId,
              row.work_report_id,
              row.person_id,
              row.base_member_share_amount,
              multiplier,
              shareBps,
              row.worker_display_name_snapshot,
              row.task_mode_snapshot,
              row.member_snapshot,
              row.report_snapshot,
              row.operation_event_id,
              row.request_id,
            ],
          ),
        ).rejects.toThrow(/parent responsibility snapshots/);
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    };

    await attempt("2.000", 1);
    await attempt("1.000", 2);
  });

  it("rejects a finalized root whose command snapshot differs from the draft", async () => {
    const order = await createReviewedOrder("root-copy", "individual");
    const saved = await responsibility.saveDraft(
      actor(
        ids.production,
        ["production_management"],
        "responsibility:determine",
      ),
      order.orderId,
      {
        expectedOrderVersion: order.orderVersion,
        expectedCurrentDeterminationVersion: null,
        handlerUserId: ids.production,
        reason: "原始根快照",
        processes: [
          {
            configurationItemId: order.itemId,
            multiplier: "1.000",
            allocations: [
              { responsibilityType: "own_factory", shareBps: 10000 },
            ],
          },
        ],
      },
      "review-root-draft",
    );
    const draftId = saved.value.determination!.determinationId;
    const client = await database.connect();
    const eventId = randomUUID();
    const requestId = "review-root-tamper";
    const finalizedId = randomUUID();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO operation_events(
           event_id,request_id,actor_id,actor_roles,authorization_capability,
           action,entity_type,entity_id,before_state,after_state,reason
         ) VALUES(
           $1,$2,$3,ARRAY['production_management'],'responsibility:determine',
           'rework.responsibility.finalize','rework_order',$4,'{}','{}',
           'adversarial root copy'
         )`,
        [eventId, requestId, ids.production, order.orderId],
      );
      await client.query(
        `SELECT set_config('dx_rework.responsibility_event_id',$1,true),
                set_config('dx_rework.responsibility_request_id',$2,true)`,
        [eventId, requestId],
      );
      await client.query(
        `INSERT INTO rework_responsibility_determinations(
           determination_id,rework_order_id,determination_version,
           replaces_determination_id,source_order_review_id,stage,
           handler_user_id,created_by,reason,
           source_high_multiplier_confirmation_id,input_snapshot,
           calculation_total,operation_event_id,request_id
         )
         SELECT $1,rework_order_id,determination_version+1,determination_id,
                source_order_review_id,'finalized',handler_user_id,$2,reason,
                NULL,input_snapshot || '{"tampered":true}'::jsonb,
                calculation_total,$3,$4
         FROM rework_responsibility_determinations
         WHERE determination_id=$5`,
        [finalizedId, ids.production, eventId, requestId, draftId],
      );
      await client.query(
        `INSERT INTO rework_responsibility_processes
         SELECT $1,configuration_item_id,process_name_snapshot,
                pricing_unit_snapshot,multiplier,high_multiplier_reason,
                base_amount,responsibility_amount,$2,$3
         FROM rework_responsibility_processes
         WHERE determination_id=$4`,
        [finalizedId, eventId, requestId, draftId],
      );
      await client.query(
        `INSERT INTO rework_responsibility_allocations
         SELECT $1,configuration_item_id,responsibility_type,share_bps,
                rounded_amount,$2,$3
         FROM rework_responsibility_allocations
         WHERE determination_id=$4`,
        [finalizedId, eventId, requestId, draftId],
      );
      await client.query(
        `INSERT INTO rework_responsibility_amount_lines
         SELECT $1,configuration_item_id,work_report_id,person_id,
                responsibility_type,base_member_share_amount,multiplier,
                share_bps,unrounded_amount,rounded_amount,rounding_rule,
                worker_display_name_snapshot,task_mode_snapshot,
                member_snapshot,report_snapshot,$2,$3
         FROM rework_responsibility_amount_lines
         WHERE determination_id=$4`,
        [finalizedId, eventId, requestId, draftId],
      );
      await expect(
        client.query("SET CONSTRAINTS finalized_root_copy_complete IMMEDIATE"),
      ).rejects.toThrow(/predecessor draft root snapshot/);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
