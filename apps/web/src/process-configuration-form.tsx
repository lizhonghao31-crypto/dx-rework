import { ProcessWorkerAssignmentForm } from "./process-worker-assignment-form.js";

export function ProcessConfigurationForm({
  reworkOrderId,
  onOrderChanged,
}: {
  reworkOrderId?: string;
  onOrderChanged?: () => Promise<void> | void;
} = {}) {
  const resolvedOrderId = reworkOrderId
    ?? new URLSearchParams(window.location.search).get("rework");
  if (!resolvedOrderId) return null;
  return <ProcessWorkerAssignmentForm reworkOrderId={resolvedOrderId} onOrderChanged={onOrderChanged} />;
}
