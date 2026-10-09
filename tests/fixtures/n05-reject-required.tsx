// Offline synthetic N05 fixture: intercept every request; no API or business writes.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { WholeOrderReviewPanel } from "../../apps/web/src/whole-order-review-panel.js";
import { promptInApp } from "../../apps/web/src/system-dialog.js";
import "../../packages/ui/src/tokens.css";
import "../../packages/ui/src/components.css";
import "../../apps/web/src/dialog-visual-system.css";

const id = (suffix: string) => `00000000-0000-4000-8000-${suffix.padStart(12, "0")}`;
const processId = id("1"), reportId = id("2"), personId = id("3");
const overview = {
  reworkOrderId: id("4"), reworkStatus: "pending_order_review", orderVersion: 7,
  canReview: true, canIeReview: false, canAdjustQuantity: false, canConfirmQuantity: true,
  canReviewQuantityIncrease: false, unifiedExecutionRequired: false, tailInspectionRequired: false,
  processes: [{ configurationItemId: processId, processName: "TEST 工序", pricingUnit: "piece",
    plannedQuantity: 10, originalCompletedQuantity: 10, completedQuantity: 10,
    originalTailCheckedQuantity: 0, tailCheckedQuantity: 0, countGap: 0, complete: true, finalUnitPrice: 1 }],
  reports: [{ workReportId: reportId, workTaskId: id("5"), configurationItemId: processId,
    actualQuantity: 10, effectiveQuantity: 10, corrected: false, correctionVersion: null,
    correctedBy: null, correctedAt: null, completedAt: "2026-10-09T00:00:00.000Z", submittedBy: personId,
    assignmentMode: "individual", executionKind: "worker", members: [{ personId, displayName: "TEST 工人" }],
    rejected: false, rejectedPersonId: null, rejectionReason: null, resubmitsWorkReportId: null }],
  adjustments: [], temporaryWorkers: [], reviewId: null, finalConfirmation: null,
};
const requests: { path: string; body: unknown }[] = [];
Object.assign(window, { n05Requests: requests });
window.fetch = async (input, init) => {
  const path = String(input);
  if (path.endsWith("auth/me")) return Response.json({ status: "authorized", user: { id: personId, displayName: "TEST 主管", capabilities: [] } });
  if (init?.method === "POST") {
    if (!path.endsWith(`work-reports/${reportId}/reject`)) throw new Error("Unexpected synthetic mutation");
    requests.push({ path, body: JSON.parse(String(init.body)) });
    return Response.json(overview);
  }
  if (path.endsWith("whole-order-review")) return Response.json(overview);
  throw new Error("Unexpected synthetic read");
};

function Fixture() {
  const [result, setResult] = useState("pending");
  return <><WholeOrderReviewPanel reworkOrderId={id("4")} onChanged={async () => {}} />
    <button onClick={() => void promptInApp("其它可选输入").then(value => setResult(value === null ? "cancelled" : `value:${value}`))}>其它弹窗</button>
    <output>{result}</output></>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
