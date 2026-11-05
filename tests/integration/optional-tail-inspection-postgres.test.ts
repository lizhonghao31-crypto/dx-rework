import {readClosureWorkSummary} from '../../apps/api/src/production-platform/closure-work-summary.js';
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  CreateWorkReportSchema,
  ReviewProcessConfigurationSchema,
  SaveProcessConfigurationSchema,
  SubmitProcessConfigurationSchema,
} from "@dx-rework/contracts";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ownedPostgresSchema,createOwnedPostgresSchema,releaseOwnedPostgresSchema } from "../helpers/owned-postgres-schema.js";
import { ApplicationError } from "../../apps/api/src/platform/errors.js";

import { AccessMasterDataService } from "../../apps/api/src/access/service.js";
import { ProcessConfigurationService } from "../../apps/api/src/rework/process-configuration-service.js";
import { ProcessWorkerPlanService } from "../../apps/api/src/rework/process-worker-plan-service.js";
import { ReworkInitiationService } from "../../apps/api/src/rework/service.js";
import { ReworkV2SubmissionService } from "../../apps/api/src/rework/v2-submission-service.js";
import { WholeOrderReviewService } from "../../apps/api/src/rework/whole-order-review-service.js";
import { WorkReportingService } from "../../apps/api/src/rework/work-reporting-service.js";
import { ReworkBusinessDetailService } from "../../apps/api/src/rework/rework-business-detail-service.js";
import { OperationEventRepository } from "../../apps/api/src/tools/repositories.js";
import type { TrustedActorContext } from "../../apps/api/src/tools/repositories.js";

const { Pool } = pg;
const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const runWithPostgres = databaseUrl ? describe : describe.skip;
type Manifest = { migrations: Array<{ version: string; checksum: string }> };

const inspectionReport = {
  schemaVersion: 1 as const,
  styleName: "test-不整查-N05",
  inspectionStage: "final" as const,
  inspectionLocation: "尾部质检区",
  color: "黑色",
  sampleQuantity: 10,
  measurementUnit: "cm" as const,
  measurementPrecision: 0.1 as const,
  sizeSamples: [],
  documentChecks: {
    confirmationSample: false,
    approvalCard: false,
    supplierSelfInspection: false,
    bulkFabricInspection: false,
    exceptionReason: null,
  },
  fabricMatch: null,
  fabricMismatchReason: null,
  fitDecision: null,
  factoryPreparation: null,
  materialChecks: { physicalPerformance: null, washTest: null, productMarking: null },
  issues: [],
  nonconformanceCause: null,
  approvalOpinion: null,
  supplierSignatoryName: null,
  supplierSignedOn: null,
  inspectionDate: null,
  disposition: "rework" as const,
};

runWithPostgres("optional tail inspection PostgreSQL closure", () => {
  const schema = ownedPostgresSchema("optional_tail");
  const adminPool = new Pool({ connectionString: databaseUrl! });
  const database = new Pool({
    connectionString: databaseUrl!,
    options: `-c search_path=${schema}`,
  });
  const access = new AccessMasterDataService(database, "corp");
  const initiation = new ReworkInitiationService(database, "corp");
  const v2Submission = new ReworkV2SubmissionService(database, "corp");
  const configuration = new ProcessConfigurationService(database);
  const workerPlan = new ProcessWorkerPlanService(database);
  const reporting = new WorkReportingService(database);
  const review = new WholeOrderReviewService(database);
  const ids = {
    owner: randomUUID(),
    qc: randomUUID(),
    tail: randomUUID(),
    ie: randomUUID(),
    worker: randomUUID(),
    workerTwo: randomUUID(),
    workerThree: randomUUID(),
    merchandiser: randomUUID(),
  };
  let workerPersonIds: string[] = [];

  const actor = (
    actorId: string,
    actorRoles: readonly string[],
    authorizationCapability: string,
    ...otherCapabilities: string[]
  ): TrustedActorContext => ({
    actorId,
    actorRoles,
    authorizationCapability,
    authorizationCapabilities: Array.from(new Set([authorizationCapability, ...otherCapabilities])),
    requestId: randomUUID(),
  });
  const owner = () => actor(ids.owner, ["owner_group"], "master_data:manage");
  const qc = () => actor(ids.qc, ["quality_control"], "rework:initiate");
  const tailConfigure = () => actor(ids.tail, ["tail_supervisor"], "process:configure");
  const tailAssign = () => actor(ids.tail, ["tail_supervisor"], "work:assign", "work:report_for_worker");
  const tailAudit = () => actor(ids.tail, ["tail_supervisor"], "submission:audit");
  const ie = () => actor(ids.ie, ["ie_reviewer"], "process:review");
  const worker = () => actor(ids.worker, ["worker"], "work:report");

  beforeAll(async () => {
    await createOwnedPostgresSchema(adminPool,schema);
    const manifest = JSON.parse(await readFile(
      new URL("../../apps/api/src/platform/migration-manifest.json", import.meta.url),
      "utf8",
    )) as Manifest;
    await database.query(`
      CREATE TABLE schema_migrations (
        version text PRIMARY KEY,
        checksum char(64) NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    for (const migration of manifest.migrations) {
      await database.query(await readFile(
        new URL(`../../apps/api/migrations/${migration.version}.sql`, import.meta.url),
        "utf8",
      ));
      await database.query(
        "INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)",
        [migration.version, migration.checksum],
      );
    }

    const users = [
      [ids.owner, "老板", "owner_group"],
      [ids.qc, "质检", "quality_control"],
      [ids.tail, "尾部主管", "tail_supervisor"],
      [ids.ie, "IE", "ie_reviewer"],
      [ids.worker, "工人", "worker"],
      [ids.workerTwo, "工人二", "worker"],
      [ids.workerThree, "工人三", "worker"],
      [ids.merchandiser, "订单跟单", "order_merchandiser"],
    ] as const;
    for (const [userId, displayName, roleCode] of users) {
      await database.query(
        "INSERT INTO app_users(id,display_name,enabled) VALUES($1,$2,true)",
        [userId, displayName],
      );
      await database.query(
        `INSERT INTO identity_mappings(
           id,user_id,provider,corp_id,provider_user_id,union_id,
           active,employed,last_verified_at
         ) VALUES($1,$2,'dingtalk','corp',$3,$4,true,true,CURRENT_TIMESTAMP)`,
        [randomUUID(), userId, `ding-${userId}`, `union-${userId}`],
      );
      await database.query(
        `INSERT INTO user_role_assignments(
           assignment_id,user_id,role_code,granted_by,grant_reason
         ) VALUES($1,$2,$3,$2,'optional-tail fixture')`,
        [randomUUID(), userId, roleCode],
      );
    }
    await access.ensureOrganizationPolicy();
    workerPersonIds = await Promise.all([
      [ids.worker, "工人"],
      [ids.workerTwo, "工人二"],
      [ids.workerThree, "工人三"],
    ].map(async ([appUserId, displayName]) => (await access.createPerson(owner(), {
      personType: "internal",
      appUserId,
      displayName,
      aliases: [],
      reason: "不整查全链回归",
    })).personId));
  });

  afterAll(async () => {
    await database.end();
    await releaseOwnedPostgresSchema(adminPool,schema);
    await adminPool.end();
  });

  it.each(["qc_rework", "inhouse_finishing"] as const)("moves %s without tail inspection through N06", async (kind) => {
    const attachmentId = randomUUID();
    await database.query(
      `INSERT INTO attachments(
         attachment_id,object_key,original_filename,mime_type,size_bytes,
         sha256,uploaded_by,status,ready_at
       ) VALUES($1,$2,'test-optional-tail.webp','image/webp',10,$3,$4,'ready',CURRENT_TIMESTAMP)`,
      [attachmentId, `private/${attachmentId}.webp`, "a".repeat(64), ids.qc],
    );
    const receivingBatchId = randomUUID();
    const sourceImageId=randomUUID();
    const sourceImage=async(id:string)=>{
      const client=await database.connect();
      try{await client.query('BEGIN');
        const eventId=await new OperationEventRepository().append(client,tailConfigure(),{action:'receiving.receipt.create',entityType:'receiving_batch',entityId:receivingBatchId,after:{receivingBatchId,attachmentIds:[id]}});
        await client.query("SELECT set_config('dx_rework.receiving_event_id',$1,true),set_config('dx_rework.receiving_request_id',$2,true)",[eventId,'TEST-finishing-history']);
        await client.query("INSERT INTO attachments(attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,uploaded_by,status,ready_at,entity_type,entity_id) VALUES($1,$2,'TEST历史来源.png','image/png',100,$3,$4,'ready',CURRENT_TIMESTAMP,'receiving_batch',$5)",[id,`TEST/finishing/${id}`,'a'.repeat(64),ids.tail,receivingBatchId]);
        await client.query('COMMIT');
      }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
    };
    if (kind === "inhouse_finishing") {
      await database.query(
        "INSERT INTO receiving_batches(receiving_batch_id,style_no,created_by,delivery_note_quantity,document_quantity_adjustment,actual_quantity_adjustment) VALUES($1,$2,$3,100,100,100)",
        [receivingBatchId, `test-optional-tail-n05-${kind}`, ids.tail],
      );
      await sourceImage(sourceImageId);
    }
    const draft = await initiation.createDraft(kind === "inhouse_finishing" ? tailConfigure() : qc(), {
      ...(kind === "inhouse_finishing" ? { receivingBatchId } : {}),
      styleNo: `test-optional-tail-n05-${kind}`,
      orderQuantity: 100,
      orderNo: `test-optional-tail-n05-${kind}`,
      merchandiserUserId: ids.merchandiser,
      processingFactory: { type: "own_factory" },
      ...(kind === "qc_rework" ? { inspectionReport, attachmentIds: [attachmentId] } : {}),
      problemPart: "袖口",
      problemDescription: "test-不整查-N05",
      reworkQuantity: 10,
      tailInspectionRequired: false,
    }, randomUUID(), kind);
    const submitted = kind === "inhouse_finishing"
      ? await v2Submission.submit(tailConfigure(), draft.value.reworkOrderId,
        { expectedVersion: draft.value.version }, randomUUID(), kind)
      : await initiation.submit(qc(), draft.value.reworkOrderId,
        { expectedVersion: draft.value.version }, randomUUID());
    expect(submitted.value.tailInspectionRequired).toBe(false);

    const saved = await configuration.saveDraft(
      tailConfigure(),
      draft.value.reworkOrderId,
      SaveProcessConfigurationSchema.parse({
        expectedOrderVersion: submitted.value.version,
        items: [{
          source: "custom",
          customProcessName: "test-不整查工序",
          executionKind: "worker",
          plannedQuantity: 10,
          pricingUnit: "piece",
          unitPrice: 0.2,
        }],
      }),
      randomUUID(),
      randomUUID(),
    );
    const workerItem = saved.value.configuration!.items[0]!;
    const planned = await workerPlan.save(
      tailAssign(),
      draft.value.reworkOrderId,
      {
        expectedOrderVersion: saved.value.orderVersion,
        configurationId: saved.value.configuration!.configurationId,
        expectedConfigurationVersion: saved.value.configuration!.configurationVersion,
        assignments: [{ configurationItemId: workerItem.configurationItemId, memberIds: [workerPersonIds[0]!] }],
      },
      randomUUID(),
    );
    expect(planned.value).toMatchObject({ required: true, complete: true });
    const queued = await configuration.submit(
      tailConfigure(),
      draft.value.reworkOrderId,
      SubmitProcessConfigurationSchema.parse({
        expectedOrderVersion: saved.value.orderVersion,
        expectedConfigurationVersion: saved.value.configuration!.configurationVersion,
      }),
      randomUUID(),
    );
    const approved = await configuration.review(
      ie(),
      draft.value.reworkOrderId,
      ReviewProcessConfigurationSchema.parse({
        expectedOrderVersion: queued.value.orderVersion,
        expectedConfigurationVersion: queued.value.configuration!.configurationVersion,
        decision: "approved",
      }),
      randomUUID(),
    );
    const activated = await workerPlan.activateAfterIeApproval(
      draft.value.reworkOrderId,
      approved.value.configuration!.configurationVersion,
      randomUUID(),
    );
    expect(activated).toMatchObject({ reworkStatus: "in_progress", tasksCreated: 1 });

    const tasks = await reporting.list(tailAssign(), draft.value.reworkOrderId);
    expect(tasks.tasks).toHaveLength(1);
    expect(tasks.tasks[0]).toMatchObject({ executionKind: "worker", mode: "individual" });
    await reporting.submitReport(
      worker(),
      tasks.tasks[0]!.workTaskId,
      CreateWorkReportSchema.parse({
        expectedOrderVersion: tasks.orderVersion,
        actualQuantity: 10,
        completedAt: new Date().toISOString(),
      }),
      randomUUID(),
    );

    const n05 = await review.get(tailAudit(), draft.value.reworkOrderId);
    expect(n05).toMatchObject({
      reworkStatus: "pending_order_review",
      tailInspectionRequired: false,
      processes: [expect.objectContaining({
        configurationItemId: workerItem.configurationItemId,
        completedQuantity: 10,
        tailCheckedQuantity: 0,
        complete: true,
      })],
    });
    const closureSummary=await readClosureWorkSummary(database,(await database.query('SELECT rework_order_id,rework_kind FROM rework_orders WHERE rework_order_id=$1',[draft.value.reworkOrderId])).rows[0]);
    expect(closureSummary).toMatchObject({kind,processes:[{configurationItemId:workerItem.configurationItemId,reportedQuantity:10}]});
    expect(closureSummary.processes[0]!.reportIds.length).toBeGreaterThan(0);
    const confirmed = await review.approve(
      tailAudit(),
      draft.value.reworkOrderId,
      {
        expectedOrderVersion: n05.orderVersion,
        finalQuantities: [{
          configurationItemId: workerItem.configurationItemId,
          finalConfirmedQuantity: 10,
        }],
        processPrices: [{
          configurationItemId: workerItem.configurationItemId,
          unitPrice: 0.25,
        }],
        temporaryCoefficients: [],
      },
      randomUUID(),
    );
    expect(confirmed.value.reworkStatus).toBe("pending_final_quantity_ie_review");
    expect(confirmed.value.finalConfirmation?.prices).toEqual([{
      configurationItemId: workerItem.configurationItemId,
      originalUnitPrice: 0.2,
      proposedUnitPrice: 0.25,
      changed: true,
    }]);
    expect((await database.query(
      "SELECT unit_price::text FROM rework_process_configuration_items WHERE configuration_item_id=$1",
      [workerItem.configurationItemId],
    )).rows).toEqual([{ unit_price: "0.200" }]);
    expect((await database.query(
      `SELECT worker_reported_quantity::text,tail_reported_quantity::text,final_confirmed_quantity::text
       FROM rework_tail_completion_quantities quantity
       JOIN rework_tail_completion_confirmations confirmation USING(confirmation_id)
       WHERE confirmation.rework_order_id=$1`,
      [draft.value.reworkOrderId],
    )).rows).toEqual([{
      worker_reported_quantity: "10.00",
      tail_reported_quantity: "0.00",
      final_confirmed_quantity: "10.00",
    }]);

    const ieApproved = await review.reviewFinalQuantity(
      ie(),
      draft.value.reworkOrderId,
      {
        expectedOrderVersion: confirmed.value.orderVersion,
        decision: "approved",
      },
      randomUUID(),
    );
    expect(ieApproved.value).toMatchObject({
      reworkStatus: kind === "inhouse_finishing" ? "completed" : "pending_responsibility_determination",
      tailInspectionRequired: false,
    });
    expect(ieApproved.value.orderVersion).toBe(confirmed.value.orderVersion + 1);
    expect((await database.query(
      `SELECT report.settlement_quantity::text,report.group_amount::text
       FROM rework_work_reports report
       WHERE report.rework_order_id=$1 AND report.status='submitted'`,
      [draft.value.reworkOrderId],
    )).rows).toEqual([{
      settlement_quantity: "10.00",
      group_amount: "2.50000000",
    }]);
    expect((await database.query(
      `SELECT amount::text FROM rework_work_report_member_shares share
       JOIN rework_work_reports report USING(work_report_id)
       WHERE report.rework_order_id=$1 ORDER BY share.person_id`,
      [draft.value.reworkOrderId],
    )).rows).toEqual([{ amount: "2.50000000" }]);
    expect((await database.query(
      "SELECT unit_price::text FROM rework_process_configuration_items WHERE configuration_item_id=$1",
      [workerItem.configurationItemId],
    )).rows).toEqual([{ unit_price: "0.250" }]);
    expect((await database.query(
      `SELECT count(*)::int AS count,bool_and(reviewed_by=$2) AS reviewed_by_ie
       FROM rework_order_reviews WHERE rework_order_id=$1`,
      [draft.value.reworkOrderId, ids.ie],
    )).rows).toEqual([{ count: 1, reviewed_by_ie: true }]);
    if (kind === "inhouse_finishing") {
      const histories=new ReworkBusinessDetailService(database),viewer=tailAssign();
      const history=await histories.history(viewer,draft.value.reworkOrderId,'work_reporting');
      expect(history.reworkKind).toBe('inhouse_finishing');
      expect(history.navigation?.map(item=>item.node)).toEqual(['initiation','process_configuration','ie_review','work_reporting','whole_order_review','final_quantity_ie_review']);
      expect(history.fields).toContainEqual({label:'款号',value:`test-optional-tail-n05-${kind}`.toUpperCase()});
      expect(history.fields).toContainEqual({label:'加工厂',value:'本厂'});
      expect(history.fields).toContainEqual({label:'订单数量',value:'100'});
      expect(history.attachments.map(item=>item.attachmentId)).toEqual([sourceImageId]);
      expect(history.page?.workTasks?.tasks[0]?.submittedQuantity).toBe(10);
      await sourceImage(randomUUID());
      expect((await histories.history(viewer,draft.value.reworkOrderId,'work_reporting',history.entry.id)).attachments).toEqual(history.attachments);
      expect((await histories.history(viewer,draft.value.reworkOrderId,'initiation')).entry.label).toBe('本厂做尾');
      await expect(histories.history(owner(),draft.value.reworkOrderId,'responsibility')).rejects.toMatchObject({statusCode:404});
      expect((await database.query(
        "SELECT count(*)::int AS count FROM rework_wage_items WHERE rework_order_id=$1",
        [draft.value.reworkOrderId],
      )).rows[0]?.count).toBeGreaterThan(0);
      expect((await database.query(
        "SELECT count(*)::int AS count FROM rework_responsibility_determinations WHERE rework_order_id=$1",
        [draft.value.reworkOrderId],
      )).rows).toEqual([{ count: 0 }]);
    }
  });
});

runWithPostgres('historical sourcing image download SQL scope',()=>{
  const schema=ownedPostgresSchema('historical_source'),admin=new pg.Pool({connectionString:databaseUrl!});
  const db=new pg.Pool({connectionString:databaseUrl!,options:`-c search_path=${schema}`});
  const order=randomUUID(),batch=randomUUID(),cut=randomUUID(),source=randomUUID();
  const old=randomUUID(),replacement=randomUUID(),sibling=randomUUID(),unrelated=randomUUID();
  const viewer:TrustedActorContext={actorId:randomUUID(),actorRoles:['tail_supervisor'],authorizationCapability:'rework:view',authorizationCapabilities:['rework:view'],requestId:randomUUID()};
  const service=new ReworkBusinessDetailService(db);
  const get=vi.fn(async(actor:TrustedActorContext)=>{
    if(actor.actorId!==viewer.actorId)throw new ApplicationError('FORBIDDEN','该做尾单不可见',403);
    return {canReadBusinessDetails:true} as Awaited<ReturnType<ReworkBusinessDetailService['get']>>;
  });
  beforeEach(()=>{get.mockClear();vi.spyOn(service,'get').mockImplementation(get);});
  const binding=(attachmentId:string)=>({entityType:'sourcing_case',entityId:source,attachmentId,mimeType:'image/png'});
  beforeAll(async()=>{
    await createOwnedPostgresSchema(admin,schema);
    // Native projection SQL and the real historical line function; order authorization remains the existing get boundary.
    await db.query(`CREATE TABLE rework_orders(rework_order_id uuid,source_receiving_batch_id uuid,rework_kind text,status text);
      CREATE TABLE receiving_batches(receiving_batch_id uuid,cutting_order_id uuid);
      CREATE TABLE cutting_orders(cutting_order_id uuid,sourcing_case_id uuid,sourcing_line_position int);
      CREATE TABLE sourcing_case_lines(sourcing_case_id uuid,position int,style_no text,image_attachment_id uuid);
      CREATE TABLE sourcing_case_corrections(sourcing_case_id uuid,correction_version int,corrected_at timestamptz,lines jsonb,corrected_by uuid,operation_event_id uuid,request_id text);
      CREATE TABLE operation_events(event_id uuid,entity_type text,entity_id text,action text,after_state jsonb,created_at timestamptz);
      CREATE TABLE attachments(attachment_id uuid,status text,ready_at timestamptz);`);
    const migration=await readFile('apps/api/migrations/0206_sourcing_merchandiser_corrections.sql','utf8');
    await db.query(migration.slice(migration.indexOf('CREATE FUNCTION sourcing_case_lines_at'),migration.indexOf('CREATE OR REPLACE VIEW current_sourcing_case_lines')));
    await db.query('CREATE VIEW current_sourcing_case_lines AS SELECT line.* FROM (SELECT DISTINCT sourcing_case_id FROM sourcing_case_lines) cases CROSS JOIN LATERAL sourcing_case_lines_at(cases.sourcing_case_id) line');
    await db.query("INSERT INTO rework_orders VALUES($1,$2,'inhouse_finishing','completed')",[order,batch]);
    await db.query('INSERT INTO receiving_batches VALUES($1,$2)',[batch,cut]);
    await db.query('INSERT INTO cutting_orders VALUES($1,$2,1)',[cut,source]);
    await db.query("INSERT INTO sourcing_case_lines VALUES($1,1,'TEST历史行',$2),($1,2,'TEST兄弟行',$3)",[source,old,sibling]);
    await db.query("INSERT INTO attachments VALUES($1,'ready','2026-09-01'),($2,'ready','2026-09-05'),($3,'ready','2026-09-01'),($4,'ready','2026-09-01')",[old,replacement,sibling,unrelated]);
    await db.query("INSERT INTO operation_events VALUES($1,'rework_order',$2,'rework.finishing.draft.create',$3,'2026-09-02'),($4,'rework_order',$2,'rework.finishing.submit',$5,'2026-09-03')",[randomUUID(),order,{receivingBatchId:batch,version:1},randomUUID(),{version:2}]);
    await db.query("INSERT INTO sourcing_case_corrections VALUES($1,1,'2026-09-05',$2,NULL,NULL,'TEST historical correction')",[source,JSON.stringify([{styleNo:'TEST历史行',imageAttachmentId:replacement},{styleNo:'TEST兄弟行',imageAttachmentId:sibling}])]);
  });
  afterAll(async()=>{await db.end();await releaseOwnedPostgresSchema(admin,schema);await admin.end();});
  it('opens the prior audited image without sourcing view capability',async()=>{
    expect(viewer.authorizationCapabilities).not.toContain('sourcing:view');
    expect((await db.query('SELECT image_attachment_id FROM current_sourcing_case_lines WHERE position=1')).rows[0].image_attachment_id).toBe(replacement);
    expect(await service.canDownloadBoundAttachment(viewer,binding(old))).toBe(true);
    expect(get).toHaveBeenLastCalledWith(viewer,order);
  });
  it.each([sibling,unrelated])('rejects another row or an unreferenced image %s',async id=>{
    get.mockClear();expect(await service.canDownloadBoundAttachment(viewer,binding(id))).toBe(false);expect(get).not.toHaveBeenCalled();
  });
  it('keeps the existing order access refusal for the historical image',async()=>{
    expect(await service.canDownloadBoundAttachment({...viewer,actorId:randomUUID()},binding(old))).toBe(false);
  });
});
