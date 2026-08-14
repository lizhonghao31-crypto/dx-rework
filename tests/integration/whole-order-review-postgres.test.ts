import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AccessMasterDataService } from "../../apps/api/src/access/service.js";
import { ProcessConfigurationService } from "../../apps/api/src/rework/process-configuration-service.js";
import { ReworkInitiationService } from "../../apps/api/src/rework/service.js";
import { WholeOrderReviewService } from "../../apps/api/src/rework/whole-order-review-service.js";
import { WorkReportingService } from "../../apps/api/src/rework/work-reporting-service.js";
import type { TrustedActorContext } from "../../apps/api/src/tools/repositories.js";

const { Pool } = pg;
import { completeInspectionReport } from "../inspection-report-fixture.js";

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const runWithPostgres = databaseUrl ? describe : describe.skip;

runWithPostgres("whole-order review PostgreSQL contracts", () => {
  const schema = "whole_" + randomUUID().replaceAll("-", "");
  const admin = new Pool({ connectionString: databaseUrl! });
  const database = new Pool({ connectionString: databaseUrl!, options: "-c search_path=" + schema });
  const access = new AccessMasterDataService(database, "corp");
  const initiation = new ReworkInitiationService(database, "corp");
  const configuration = new ProcessConfigurationService(database);
  const reporting = new WorkReportingService(database);
  const review = new WholeOrderReviewService(database);
  const ids = { admin: randomUUID(), owner: randomUUID(), qc: randomUUID(), tail: randomUUID(), ie: randomUUID(), merch: randomUUID(), delegate: randomUUID(), worker: randomUUID(), outsider: randomUUID() };
  let workerPersonId = "";

  const actor = (actorId: string, actorRoles: readonly string[], authorizationCapability: string): TrustedActorContext => ({ actorId, actorRoles, authorizationCapability, requestId: randomUUID() });
  const administrator = () => actor(ids.admin, ["system_admin"], "master_data:manage");
  const owner = () => actor(ids.owner, ["owner_group"], "delegation:manage");
  const qc = () => actor(ids.qc, ["quality_control"], "rework:initiate");
  const tailConfigure = () => actor(ids.tail, ["tail_supervisor"], "process:configure");
  const tailAssign = () => actor(ids.tail, ["tail_supervisor"], "work:assign");
  const tailAudit = () => actor(ids.tail, ["tail_supervisor"], "submission:audit");
  const tailAdjust = () => actor(ids.tail, ["tail_supervisor"], "quantity:adjust");
  const ie = () => actor(ids.ie, ["ie_reviewer"], "process:review");
  const merch = () => actor(ids.merch, ["order_merchandiser"], "quantity:confirm");
  const worker = () => actor(ids.worker, ["worker"], "work:report");

  beforeAll(async () => {
    await admin.query("CREATE SCHEMA " + schema);
    for (const migration of [
      "0001_platform_foundation.sql", "0002_dingtalk_identity_access.sql", "0003_identity_union_continuity.sql",
      "0004_public_tools_foundation.sql", "0005_access_master_data.sql", "0006_rework_initiation.sql",
      "0056_n01_digital_inspection_report.sql",
      "0007_process_configuration_ie_review.sql", "0008_worker_assignment_reporting.sql",
      "0009_whole_order_review_quantity_adjustment.sql", "0039_practical_quantity_amount_precision.sql",
    ]) {
      await database.query(await readFile(new URL("../../apps/api/migrations/" + migration, import.meta.url), "utf8"));
    }
    const users: Array<readonly [string, string, string]> = [
      [ids.admin, "系统管理员", "system_admin"], [ids.owner, "老板", "owner_group"], [ids.qc, "品控", "quality_control"],
      [ids.tail, "李同生", "tail_supervisor"], [ids.ie, "IE", "ie_reviewer"], [ids.merch, "跟单", "order_merchandiser"],
      [ids.delegate, "授权代理", "quality_control"], [ids.worker, "工人", "worker"], [ids.outsider, "无权人员", "system_admin"],
    ];
    for (const [userId, displayName, roleCode] of users) {
      await database.query("INSERT INTO app_users(id,display_name) VALUES($1,$2)", [userId, displayName]);
      await database.query("INSERT INTO identity_mappings(id,user_id,provider,corp_id,provider_user_id,union_id,active,employed,last_verified_at) VALUES($1,$2,'dingtalk','corp',$3,$4,true,true,CURRENT_TIMESTAMP)", [randomUUID(), userId, "ding-" + userId, "union-" + userId]);
      await database.query("INSERT INTO user_role_assignments(assignment_id,user_id,role_code,granted_by,grant_reason) VALUES($1,$2,$3,$2,'bootstrap')", [randomUUID(), userId, roleCode]);
    }
    await access.ensureOrganizationPolicy();
    workerPersonId = (await access.createPerson(administrator(), { personType: "internal", appUserId: ids.worker, displayName: "工人", aliases: [], reason: "PR-08测试" })).personId;
  });

  afterAll(async () => { await database.end(); await admin.query("DROP SCHEMA IF EXISTS " + schema + " CASCADE"); await admin.end(); });

  const createOrder = async (plan: number, reports: readonly number[], pricingUnit: "piece" | "hour" = "piece") => {
    const draft = await initiation.createDraft(qc(), { styleNo: "PD" + randomUUID().slice(0, 8), merchandiserUserId: ids.merch, processingFactory: { type: "own_factory" }, problemPart: "袖口", problemDescription: "PR-08", reworkQuantity: Math.ceil(plan), inspectionReport: completeInspectionReport() }, randomUUID());
    const submitted = await initiation.submit(qc(), draft.value.reworkOrderId, { expectedVersion: draft.value.version }, randomUUID());
    const saved = await configuration.saveDraft(tailConfigure(), draft.value.reworkOrderId, { expectedOrderVersion: submitted.value.version, items: [{ source: "custom", customProcessName: "审核工序" + randomUUID().slice(0, 4), pricingUnit, plannedQuantity: plan, unitPrice: 1 }] }, randomUUID());
    const queued = await configuration.submit(tailConfigure(), draft.value.reworkOrderId, { expectedOrderVersion: saved.value.orderVersion, expectedConfigurationVersion: saved.value.configuration!.configurationVersion }, randomUUID());
    const approved = await configuration.review(ie(), draft.value.reworkOrderId, { expectedOrderVersion: queued.value.orderVersion, expectedConfigurationVersion: queued.value.configuration!.configurationVersion, decision: "approved" }, randomUUID());
    const itemId = approved.value.configuration!.items[0]!.configurationItemId;
    const task = await reporting.createTask(tailAssign(), draft.value.reworkOrderId, { expectedOrderVersion: approved.value.orderVersion, configurationItemId: itemId, mode: "individual", members: [{ personId: workerPersonId }] }, randomUUID());
    const reportIds: string[] = [];
    for (const quantity of reports) {
      const current = await reporting.list(tailAssign(), draft.value.reworkOrderId);
      const report = await reporting.submitReport(worker(), task.value.workTaskId, { expectedOrderVersion: current.orderVersion, actualQuantity: quantity, completedAt: new Date().toISOString() }, randomUUID());
      reportIds.push(report.value.workReportId);
    }
    return { reworkOrderId: draft.value.reworkOrderId, configurationItemId: itemId, workTaskId: task.value.workTaskId, reportIds };
  };

  it("allows only complete orders into review, persists a full snapshot, and accepts one concurrent approval", async () => {
    const complete = await createOrder(2, [2]);
    const before = await review.get(tailAudit(), complete.reworkOrderId);
    expect(before.processes).toEqual([expect.objectContaining({ complete: true, completedQuantity: 2, plannedQuantity: 2 })]);
    const first = review.approve(tailAudit(), complete.reworkOrderId, { expectedOrderVersion: before.orderVersion }, randomUUID());
    const second = review.approve(tailAudit(), complete.reworkOrderId, { expectedOrderVersion: before.orderVersion }, randomUUID());
    const outcomes = await Promise.allSettled([first, second]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect((await database.query("SELECT count(*)::int count FROM rework_order_reviews WHERE rework_order_id=$1", [complete.reworkOrderId])).rows[0]).toEqual({ count: 1 });
    expect((await database.query("SELECT review_snapshot FROM rework_order_reviews WHERE rework_order_id=$1", [complete.reworkOrderId])).rows[0]?.review_snapshot).toEqual(expect.objectContaining({ processes: expect.any(Array), reports: expect.any(Array) }));

    const incomplete = await createOrder(5, [3]);
    const incompleteView = await review.get(tailAudit(), incomplete.reworkOrderId);
    await expect(review.approve(tailAudit(), incomplete.reworkOrderId, { expectedOrderVersion: incompleteView.orderVersion }, randomUUID())).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
  });

  it("rejects only the selected report, invalidates completion, and keeps the historical version when resubmitted", async () => {
    const order = await createOrder(4, [2, 2]);
    const before = await review.get(tailAudit(), order.reworkOrderId);
    const rejected = await review.rejectReport(tailAudit(), order.reportIds[0]!, { expectedOrderVersion: before.orderVersion, rejectedPersonId: workerPersonId, reason: "数量凭据不完整" }, randomUUID());
    expect(rejected.value.reworkStatus).toBe("in_progress");
    expect(rejected.value.reports.filter((report) => report.rejected)).toHaveLength(1);
    expect(rejected.value.reports.find((report) => report.workReportId === order.reportIds[1])?.rejected).toBe(false);
    expect(rejected.value.processes[0]?.complete).toBe(false);
    const corrected = await reporting.submitReport(worker(), order.workTaskId, { expectedOrderVersion: rejected.value.orderVersion, actualQuantity: 2, completedAt: new Date().toISOString(), resubmitsWorkReportId: order.reportIds[0] }, randomUUID());
    expect((await database.query("SELECT resubmits_work_report_id FROM rework_work_reports WHERE work_report_id=$1", [corrected.value.workReportId])).rows[0]).toEqual({ resubmits_work_report_id: order.reportIds[0] });
    expect((await review.get(tailAudit(), order.reworkOrderId)).processes[0]?.complete).toBe(true);
  });

  it("records decreases, validates completed quantity, confirms increases through the bound merchandiser, and sends process changes to IE", async () => {
    const incomplete = await createOrder(5, [3]);
    const current = await review.get(tailAdjust(), incomplete.reworkOrderId);
    const decrease = await review.decrease(tailAdjust(), incomplete.reworkOrderId, { expectedOrderVersion: current.orderVersion, configurationItemId: incomplete.configurationItemId, newPlannedQuantity: 3, reason: "实裁减少" }, randomUUID());
    expect(decrease.value.status).toBe("effective");
    expect((await review.get(tailAudit(), incomplete.reworkOrderId)).reworkStatus).toBe("pending_order_review");
    expect((await database.query("SELECT before_state,after_state,authorization_capability FROM operation_events WHERE entity_id=$1 AND action='rework.quantity.decrease'", [incomplete.reworkOrderId])).rows[0]).toEqual(expect.objectContaining({ authorization_capability: "quantity:adjust" }));

    const tooLow = await createOrder(5, [3]);
    const tooLowView = await review.get(tailAdjust(), tooLow.reworkOrderId);
    await expect(review.decrease(tailAdjust(), tooLow.reworkOrderId, { expectedOrderVersion: tooLowView.orderVersion, configurationItemId: tooLow.configurationItemId, newPlannedQuantity: 2, reason: "错误减少" }, randomUUID())).rejects.toMatchObject({ code: "CONFLICT" });

    const completed = await createOrder(2, [2]);
    const completedView = await review.get(tailAdjust(), completed.reworkOrderId);
    const requested = await review.requestIncrease(tailAdjust(), completed.reworkOrderId, { expectedOrderVersion: completedView.orderVersion, configurationItemId: completed.configurationItemId, newPlannedQuantity: 4, reason: "补料", expiresAt: new Date(Date.now() + 60_000).toISOString(), requiresIeReview: true }, "increase-once");
    const replay = await review.requestIncrease(tailAdjust(), completed.reworkOrderId, { expectedOrderVersion: completedView.orderVersion, configurationItemId: completed.configurationItemId, newPlannedQuantity: 4, reason: "补料", expiresAt: requested.value.expiresAt!, requiresIeReview: true }, "increase-once");
    expect(replay.reused).toBe(true);
    const concurrent = await Promise.allSettled([
      review.requestIncrease(tailAdjust(), completed.reworkOrderId, { expectedOrderVersion: requested.value.adjustmentVersion + 1, configurationItemId: completed.configurationItemId, newPlannedQuantity: 5, reason: "重复补料", expiresAt: new Date(Date.now() + 60_000).toISOString(), requiresIeReview: false }, randomUUID()),
      review.requestIncrease(tailAdjust(), completed.reworkOrderId, { expectedOrderVersion: requested.value.adjustmentVersion + 1, configurationItemId: completed.configurationItemId, newPlannedQuantity: 6, reason: "并发补料", expiresAt: new Date(Date.now() + 60_000).toISOString(), requiresIeReview: false }, randomUUID()),
    ]);
    expect(concurrent.every((outcome) => outcome.status === "rejected")).toBe(true);
    await expect(review.confirmIncrease(actor(ids.outsider, ["system_admin"], "quantity:confirm"), requested.value.adjustmentId, { expectedOrderVersion: requested.value.adjustmentVersion, expectedAdjustmentVersion: requested.value.adjustmentVersion, decision: "confirmed", actualCutQuantity: 4, actualReturnQuantity: 4, allowedMaximumQuantity: 4 }, randomUUID())).rejects.toMatchObject({ code: "FORBIDDEN" });
    const confirmView = await review.get(merch(), completed.reworkOrderId);
    const confirmed = await review.confirmIncrease(merch(), requested.value.adjustmentId, { expectedOrderVersion: confirmView.orderVersion, expectedAdjustmentVersion: requested.value.adjustmentVersion, decision: "confirmed", actualCutQuantity: 4, actualReturnQuantity: 4, allowedMaximumQuantity: 4 }, randomUUID());
    expect(confirmed.value.status).toBe("pending_ie_review");
    const ieView = await review.get(ie(), completed.reworkOrderId);
    const reviewed = await review.reviewIncrease(ie(), requested.value.adjustmentId, { expectedOrderVersion: ieView.orderVersion, expectedAdjustmentVersion: confirmed.value.adjustmentVersion, decision: "approved" }, randomUUID());
    expect(reviewed.value.status).toBe("effective");
    expect((await review.get(tailAudit(), completed.reworkOrderId)).reworkStatus).toBe("in_progress");

    const rejectedOrder = await createOrder(2, [2]);
    const rejectedView = await review.get(tailAdjust(), rejectedOrder.reworkOrderId);
    const rejectedRequest = await review.requestIncrease(tailAdjust(), rejectedOrder.reworkOrderId, { expectedOrderVersion: rejectedView.orderVersion, configurationItemId: rejectedOrder.configurationItemId, newPlannedQuantity: 4, reason: "补料后取消", expiresAt: new Date(Date.now() + 60_000).toISOString(), requiresIeReview: false }, randomUUID());
    const merchView = await review.get(merch(), rejectedOrder.reworkOrderId);
    const rejectedDecision = await review.confirmIncrease(merch(), rejectedRequest.value.adjustmentId, { expectedOrderVersion: merchView.orderVersion, expectedAdjustmentVersion: rejectedRequest.value.adjustmentVersion, decision: "rejected", actualCutQuantity: 0, actualReturnQuantity: 0, allowedMaximumQuantity: 1, reason: "不再补料" }, randomUUID());
    expect(rejectedDecision.value.status).toBe("rejected");
  });

  it("honors active scoped delegation while rejecting an administrator bypass", async () => {
    const order = await createOrder(2, [2]);
    await access.createDelegation(owner(), { grantorUserId: ids.tail, granteeUserId: ids.delegate, capability: "submission:audit", scopeType: "rework_order", scopeId: order.reworkOrderId, validFrom: new Date(Date.now() - 1_000).toISOString(), validUntil: new Date(Date.now() + 60_000).toISOString(), reason: "李同生临时代理" });
    const delegated = actor(ids.delegate, ["quality_control"], "submission:audit");
    const overview = await review.get(delegated, order.reworkOrderId);
    expect(overview.canReview).toBe(true);
    await expect(review.get(actor(ids.outsider, ["system_admin"], "access:admin"), order.reworkOrderId)).rejects.toMatchObject({ code: "FORBIDDEN" });

    await access.createDelegation(owner(), { grantorUserId: ids.tail, granteeUserId: ids.outsider, capability: "quantity:adjust", scopeType: "process", scopeId: order.configurationItemId, validFrom: new Date(Date.now() - 1_000).toISOString(), validUntil: new Date(Date.now() + 60_000).toISOString(), reason: "工序级数量代理" });
    const processDelegate = actor(ids.outsider, ["system_admin"], "quantity:adjust");
    const scoped = await review.get(processDelegate, order.reworkOrderId, order.configurationItemId);
    expect(scoped).toEqual(expect.objectContaining({ canReview: false, reviewId: null }));
    expect(scoped.processes.map((process) => process.configurationItemId)).toEqual([order.configurationItemId]);
    expect(scoped.reports.every((report) => report.configurationItemId === order.configurationItemId)).toBe(true);
    await expect(review.get(processDelegate, order.reworkOrderId)).rejects.toMatchObject({ code: "FORBIDDEN" });
    const anotherOrder = await createOrder(1, [1]);
    await expect(review.get(processDelegate, anotherOrder.reworkOrderId, order.configurationItemId)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("accepts one-decimal quantities for both units and rejects further precision", async () => {
    const hourOrder = await createOrder(1, [1], "hour");
    const hourView = await review.get(tailAdjust(), hourOrder.reworkOrderId);
    const hourIncrease = await review.requestIncrease(tailAdjust(), hourOrder.reworkOrderId, { expectedOrderVersion: hourView.orderVersion, configurationItemId: hourOrder.configurationItemId, newPlannedQuantity: 1.1, reason: "小时补量", expiresAt: new Date(Date.now() + 60_000).toISOString(), requiresIeReview: false }, randomUUID());
    expect(hourIncrease.value.requestedPlannedQuantity).toBe(1.1);

    const pieceOrder = await createOrder(1, [1], "piece");
    const pieceView = await review.get(tailAdjust(), pieceOrder.reworkOrderId);
    const pieceIncrease = await review.requestIncrease(tailAdjust(), pieceOrder.reworkOrderId, { expectedOrderVersion: pieceView.orderVersion, configurationItemId: pieceOrder.configurationItemId, newPlannedQuantity: 1.1, reason: "按件补量", expiresAt: new Date(Date.now() + 60_000).toISOString(), requiresIeReview: false }, randomUUID());
    expect(pieceIncrease.value.requestedPlannedQuantity).toBe(1.1);

    const invalidOrder = await createOrder(1, [1], "hour");
    const invalidView = await review.get(tailAdjust(), invalidOrder.reworkOrderId);
    await expect(review.requestIncrease(tailAdjust(), invalidOrder.reworkOrderId, { expectedOrderVersion: invalidView.orderVersion, configurationItemId: invalidOrder.configurationItemId, newPlannedQuantity: 1.25, reason: "精度错误", expiresAt: new Date(Date.now() + 60_000).toISOString(), requiresIeReview: false }, randomUUID())).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});
