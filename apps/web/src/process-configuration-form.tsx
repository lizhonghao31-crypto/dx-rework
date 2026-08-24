import { ProcessWorkerAssignmentForm } from "./process-worker-assignment-form.js";

export function ProcessConfigurationForm({
  reworkOrderId,
  onOrderChanged,
  embedded = false,
  workspaceNode = "process_configuration",
}: {
  reworkOrderId?: string;
  onOrderChanged?: () => Promise<void> | void;
  embedded?: boolean;
  workspaceNode?: "process_configuration" | "ie_review";
} = {}) {
  const resolvedOrderId = reworkOrderId
    ?? new URLSearchParams(window.location.search).get("rework");
  if (!resolvedOrderId) return null;
  return <ProcessWorkerAssignmentForm
    reworkOrderId={resolvedOrderId}
    embedded={embedded}
    workspaceNode={workspaceNode}
    {...(onOrderChanged ? { onOrderChanged } : {})}
  />;
}
