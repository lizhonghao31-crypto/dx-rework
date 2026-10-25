import "@dx-rework/ui/tokens.css";
import "@dx-rework/ui/components.css";
import "../../apps/web/src/styles.css";
import "../../apps/web/src/dialog-visual-system.css";
import { createRoot } from "react-dom/client";
import { CockpitProductionSettings } from "../../apps/web/src/cockpit-production-settings.js";

const mode = new URLSearchParams(location.search).get("mode"), writes: unknown[] = [];
Object.assign(window, { slaPolicyEvidence: { writes } });
const policy = { nodeKey: "development_pattern", label: "开发纸样（较长名称与实际参数展示）", version: 2, slaHours: 48,
  warningRatio: 0.7, changedAt: "2026-10-23T08:00:00Z", changedBy: null, note: "", applicationScope: "new_orders",
  warningRatioEditable: false, durationRequired: true, durationEditable: true };
window.fetch = async (input, init) => {
  const path = new URL(String(input), location.origin).pathname;
  if (path.endsWith("/access/options")) return Response.json({ manage: mode !== "readonly", customers: false });
  if (path.endsWith("/deadline-policies")) return Response.json([policy]);
  if (init?.method === "PUT" && path.endsWith("/deadline-policies/development_pattern")) {
    const body = JSON.parse(String(init.body)); writes.push(body);
    if (mode === "conflict") return Response.json({ error: { code: "DIGITAL_TASK_CONFLICT", message: "时效参数已更新，请刷新" } }, { status: 409 });
    policy.version++; policy.slaHours = body.slaHours;
    return Response.json({ nodeKey: policy.nodeKey, version: policy.version, affectedTasks: 0, scope: "new_orders" });
  }
  throw new Error(`Unexpected settings fixture request: ${path}`);
};
createRoot(document.getElementById("root")!).render(<main className="dx-production-ui"><CockpitProductionSettings /></main>);
