// Offline synthetic detail-page fixture: every fetch is intercepted, no business API.
import { createRoot } from "react-dom/client";
import { ReworkDetailPage, type ReworkBusinessDetail } from "../../apps/web/src/rework-detail-page.js";
import "../../packages/ui/src/tokens.css";
import "../../packages/ui/src/components.css";
import "../../apps/web/src/styles.css";
import "../../apps/web/src/workflow-shell.css";
import "../../apps/web/src/workflow-state-visual.css";
import "../../apps/web/src/ui-polish.css";

const id = (suffix: string) => `00000000-0000-4000-8000-${suffix.padStart(12, "0")}`;
const params = new URLSearchParams(location.search);
const stage = params.get("stage") ?? "N04";
const role = params.get("role") ?? "ie";
const readOnly = params.get("readonly") === "1";
const processId = id("1"), orderId = id("2"), userId = id("3");
const capabilities = role === "tail" ? ["submission:audit", "work:assign"] : role === "mixed" ? ["process:review", "submission:audit"] : ["process:review"];
const user = { id: userId, displayName: "TEST IE", isRoot: role === "root", businessRoles: role === "mixed" ? ["ie_reviewer", "tail_supervisor"] : [role === "tail" ? "tail_supervisor" : "ie_reviewer"], capabilities, effectiveWriteCapabilities: readOnly ? [] : capabilities, readOnlyModules: readOnly ? ["rework"] : [] };
const canRecord = role !== "tail" && stage !== "N06";
const tailRequired = params.get("tail") === "1";
const entries = [{ entryId: id("4"), configurationItemId: processId, processName: "TEST 工序", quantity: 3, note: "原预核", recordedBy: "TEST IE", recordedAt: "2026-10-11T00:00:00.000Z" }];
const detail: ReworkBusinessDetail = {
  reworkOrderId: orderId, reworkNo: "RW-TEST", reworkKind: "qc_rework", status: stage === "N04" ? "in_progress" : stage === "N06" ? "pending_final_quantity_ie_review" : "pending_order_review", version: 7,
  styleNo: "TEST", customerSupplyCode: null, factoryStyleNo: null, orderNo: "TEST-ONLY", orderQuantity: 10, sourceReceivingActualQuantity: 10,
  iePrecounts: { canRecord, processes: [{ configurationItemId: processId, processName: "TEST 工序" }], entries },
  defectiveQuantity: { receiving: 2, receivingLinked: true, tail: 0, total: 2, canAddTail: false, tailEntries: [] },
  supplyContext: { washingSupplierName: null, embroiderySupplierName: null, fabricSupplierName: null, embroideryMerchandiserName: null },
  merchandiser: null, processingFactory: { type: "own_factory", supplierId: null, displayName: "TEST 本厂" }, reworkReason: "TEST", reworkProcess: "TEST 工序", problemPart: null, problemDescription: null, reworkQuantity: 10,
  tailInspectionRequired: tailRequired, canReadBusinessDetails: true, singlePieceReworkTotal: 1, inspectionReport: null,
  createdBy: { userId: id("5"), displayName: "TEST QC" }, processConfigurationCreatedBy: null,
  createdAt: "2026-10-11T00:00:00.000Z", updatedAt: "2026-10-11T00:00:00.000Z", submittedAt: null, cancelledAt: null, cancelReason: null,
  settlementStatus: "not_required", wageSettlementStatus: "not_required", unsettledWagePeriods: [], attachments: [], workflowHistory: [],
};
const overview = {
  reworkOrderId: orderId, reworkStatus: detail.status, orderVersion: 7,
  canReview: ["tail", "root", "mixed", "delegated-ie"].includes(role), canIeReview: stage === "N06" && role !== "tail", canAdjustQuantity: false, canConfirmQuantity: false,
  canReviewQuantityIncrease: false, unifiedExecutionRequired: false, tailInspectionRequired: tailRequired,
  processes: [{ configurationItemId: processId, processName: "TEST 工序", pricingUnit: "piece", plannedQuantity: 10, originalCompletedQuantity: 10, completedQuantity: 10, originalTailCheckedQuantity: tailRequired ? 10 : 0, tailCheckedQuantity: tailRequired ? 10 : 0, countGap: 0, complete: true, finalUnitPrice: 1 }],
  reports: [], adjustments: [], temporaryWorkers: [], reviewId: null, finalConfirmation: null,
};
const requests: { path: string; method: string; body: unknown }[] = [];
Object.assign(window, { iePrecountRequests: requests, iePrecountEntries: entries, iePrecountStatus: detail.status });
window.fetch = async (input, init) => {
  const path = String(input), method = init?.method ?? "GET";
  requests.push({ path, method, body: init?.body ? JSON.parse(String(init.body)) : null });
  if (method !== "GET") {
    if (!path.endsWith(`/rework-orders/${orderId}/ie-precounts`)) throw new Error("Unexpected synthetic mutation");
    if (!canRecord || (readOnly && role !== "root")) return Response.json({ error: { message: "当前角色无权记录预核" } }, { status: 403 });
    const body = JSON.parse(String(init?.body));
    entries.unshift({ entryId: id(String(entries.length + 10)), configurationItemId: body.configurationItemId, processName: "TEST 工序", quantity: body.quantity, note: body.note ?? null, recordedBy: "TEST IE", recordedAt: "2026-10-11T01:00:00.000Z" });
    return Response.json(detail);
  }
  if (path.endsWith("auth/me")) return Response.json({ status: "authorized", user });
  if (path.endsWith("business-detail")) return Response.json(detail);
  if (path.endsWith("whole-order-review")) {
    if (params.get("fault") === "overview") return Response.json({ error: { message: "TEST 审核摘要读取失败" } }, { status: 500 });
    if (params.get("fault") === "missing") return Response.json({ error: { message: "TEST 订单不存在" } }, { status: 404 });
    // Match the actual service: ordinary IE cannot read formal N05 confirmation.
    if (stage === "N05" && role === "ie") return Response.json({ error: { code: "FORBIDDEN", message: "当前用户无权读取最终数量确认信息" } }, { status: 403 });
    if (stage === "N06" && role === "tail") return Response.json({ error: { code: "FORBIDDEN", message: "当前用户无权读取最终数量确认信息" } }, { status: 403 });
    return Response.json(overview);
  }
  if (path.endsWith("tail-inspection")) {
    if (!["root", "tail", "mixed"].includes(role)) return Response.json({ error: { message: "当前角色无权查看整查报数" } }, { status: 403 });
    if (params.get("fault") === "tail") return Response.json({ error: { message: "TEST 整查读取失败" } }, { status: 500 });
    return Response.json({ reworkOrderId: orderId, reworkStatus: detail.status, assignments: [], processes: [{configurationItemId: processId, processName: "TEST 工序", inspectedQuantity: 10}] });
  }
  if (path.endsWith("work-task-adjustment-options")) return Response.json({ people: [] });
  if (path.endsWith("process-configuration")) return Response.json({ reworkOrderId: orderId, reworkStatus: detail.status, orderVersion: 7, configuration: null, reworkNo: "RW-TEST" });
  if (path.endsWith("work-tasks")) {
    if (params.get("fault") === "facts") return Response.json({ error: { message: "TEST 执行事实读取失败" } }, { status: 403 });
    return Response.json({ reworkOrderId: orderId, reworkStatus: detail.status, orderVersion: 7, tasks: [{ workTaskId: id("6"), reworkOrderId: orderId, configurationItemId: processId, processName: "TEST 工序", executionKind: "worker", pricingUnit: "piece", plannedQuantity: 10, unitPrice: 1, mode: "individual", version: 1, status: "active", canSubmitReport: false, members: [{ personId: id("7"), displayName: "TEST 工人", personType: "internal" }], submittedQuantity: stage === "N04" ? 0 : 10, remainingQuantity: stage === "N04" ? 10 : 0 }, { workTaskId: id("8"), reworkOrderId: orderId, configurationItemId: id("9"), processName: "整查", executionKind: "tail_inspection", pricingUnit: "piece", plannedQuantity: 10, unitPrice: null, mode: "individual", version: 1, status: "active", canSubmitReport: false, members: [{ personId: id("10"), displayName: "TEST 整查员", personType: "internal" }], submittedQuantity: stage === "N04" ? 0 : 10, remainingQuantity: stage === "N04" ? 10 : 0 }] });
  }
  throw new Error(`Unexpected synthetic read: ${path}`);
};
createRoot(document.getElementById("root")!).render(<ReworkDetailPage reworkOrderId={orderId} />);
