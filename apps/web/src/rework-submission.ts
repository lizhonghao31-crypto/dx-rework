import type { ReworkOrderResponse } from "@dx-rework/contracts";

export const isReworkFormMutationAllowed = (state: Readonly<{
  busy: boolean;
  uploading: boolean;
  restoringDraft: boolean;
}>): boolean => !state.busy && !state.uploading && !state.restoringDraft;

export type PendingSubmitAttempt = Readonly<{
  reworkOrderId: string;
  body: Readonly<{ expectedVersion: number }>;
  key: string;
}>;

export async function executeReworkSubmit(
  currentOrder: ReworkOrderResponse | null,
  pendingSubmit: PendingSubmitAttempt | null,
  persistDraft: () => Promise<ReworkOrderResponse>,
  createAttempt: (saved: ReworkOrderResponse) => PendingSubmitAttempt,
  send: (attempt: PendingSubmitAttempt) => Promise<ReworkOrderResponse>,
): Promise<ReworkOrderResponse> {
  if (
    currentOrder
    && pendingSubmit?.reworkOrderId === currentOrder.reworkOrderId
    && pendingSubmit.body.expectedVersion === currentOrder.version
  ) {
    return send(pendingSubmit);
  }
  const saved = await persistDraft();
  return send(createAttempt(saved));
}
