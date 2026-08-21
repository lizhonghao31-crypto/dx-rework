import { ReworkInitiationV2Form } from "./rework-v2-form.js";

export function ReworkInitiationForm({
  reworkOrderId,
  onOrderChanged,
  embedded = false,
}: {
  reworkOrderId?: string;
  onOrderChanged?: () => Promise<void> | void;
  embedded?: boolean;
} = {}) {
  return <ReworkInitiationV2Form
    {...(reworkOrderId ? { reworkOrderId } : {})}
    embedded={embedded}
    {...(onOrderChanged ? { onOrderChanged } : {})}
  />;
}
