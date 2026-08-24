import { ProcessWorkerAssignmentForm } from "./process-worker-assignment-form.js";

export function ProcessConfigurationForm({
  reworkOrderId,
  onOrderChanged,
  embedded = false,
}: {
  reworkOrderId?: string;
  onOrderChanged?: () => Promise<void> | void;
  embedded?: boolean;
} = {}) {
  const resolvedOrderId = reworkOrderId
    ?? new URLSearchParams(window.location.search).get("rework");
  if (!resolvedOrderId) return null;
  return <ProcessWorkerAssignmentForm
    reworkOrderId={resolvedOrderId}
    embedded={embedded}
    {...(onOrderChanged ? { onOrderChanged } : {})}
  />;
}
