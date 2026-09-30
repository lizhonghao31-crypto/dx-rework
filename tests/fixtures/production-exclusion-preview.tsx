import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ProductionExclusionPreviewSchema } from "@dx-rework/contracts";
import { ProductionExclusionControls } from "../../apps/web/src/production-exclusion-controls.js";
import "../../packages/ui/src/tokens.css";
import "../../packages/ui/src/components.css";
import "../../apps/web/src/styles.css";
import "../../apps/web/src/sourcing-workspace.css";
const id = "00000000-0000-4000-8000-000000000100", user = "00000000-0000-4000-8000-000000000001";
const record = ProductionExclusionPreviewSchema.parse({ order: {
  productionOrderId: id, sourcingCaseId: user, status: "in_production", dispatchedAt: "2026-09-07T00:00:00Z",
  sourceCaseArchived: true, decisionVersion: 1, sourcingContractDocumentId: user, contractNumber: "合成合同-100", contractVersion: 1,
  supplierId: user, supplierName: "合成精确对象验证加工厂", gender: "女装", styleName: "合成长款名称验证", quantity: 12345, completedQuantity: 100,
  processes: ["合成缝制"], deliveryDate: "2026-09-15", firstStyleNo: "DX-FIXTURE-A", dispatchedBy: user,
  firstReportedOn: "2026-09-07", reportingState: null, timeProgress: null, progressAlert: null,
  lines: [{ position: 1, styleNo: "DX-FIXTURE-A", alternateStyleNo: null, color: "蓝色", quantity: 12345, completedQuantity: 100 }],
}, version: "a".repeat(64), reportCount: 2, receiptIds: [], exclusion: null });
let writes = 0, versionChanged = false;
let notify = () => {};
const reply = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
globalThis.fetch = async (input, init) => {
  if (!String(input).endsWith(`/${id}/exclusion`)) return reply({ error: { message: "合成对象不存在" } }, 404);
  if (init?.method === "POST") {
    writes++; notify();
    const body = JSON.parse(String(init.body));
    if (body.expectedVersion !== (versionChanged ? "b".repeat(64) : record.version)) return reply({ error: { message: "生产记录已变化，请重新预览后确认" } }, 409);
    record.exclusion = { reason: body.reason, excludedBy: user, excludedAt: "2026-09-07T00:00:00Z", operationEventId: user };
  }
  return reply({ ...record, version: versionChanged ? "b".repeat(64) : record.version });
};
function Fixture() {
  const [, redraw] = useState(0);
  notify = () => redraw(n => n + 1);
  return <main style={{ padding: 16 }}><aside style={{ padding: 12, background: "white" }}>
    <b>合成对象回归 · 不连接生产</b><p>测试ID：{id}</p>
    <button onClick={() => { versionChanged = true; redraw(n => n + 1); }}>模拟预览后新增上报</button><p>合成写请求 {writes} 次</p>
  </aside><ProductionExclusionControls onExcluded={() => redraw(n => n + 1)} /></main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
