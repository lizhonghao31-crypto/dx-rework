import { ProcessWorkerAssignmentForm, type ProcessWorkerAssignmentDetail } from "./process-worker-assignment-form.js";

export function ProcessConfigurationForm({
  reworkOrderId,
  initialDetail,
  onOrderChanged,
  embedded = false,
  workspaceNode = "process_configuration",
}: {
  reworkOrderId?: string;
  initialDetail?: ProcessWorkerAssignmentDetail;
  onOrderChanged?: () => Promise<void> | void;
  embedded?: boolean;
  workspaceNode?: "process_configuration" | "ie_review";
} = {}) {
  const resolvedOrderId = reworkOrderId
    ?? new URLSearchParams(window.location.search).get("rework");
  if (!resolvedOrderId) return null;
  return <ProcessWorkerAssignmentForm
    reworkOrderId={resolvedOrderId}
    {...(initialDetail ? { initialDetail } : {})}
    embedded={embedded}
    workspaceNode={workspaceNode}
    {...(onOrderChanged ? { onOrderChanged } : {})}
  />;
}
