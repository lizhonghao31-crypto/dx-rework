export type WorkReportPayload = Readonly<{
  expectedOrderVersion: number;
  actualQuantity: number;
  completedAt: string;
}>;
export type PendingWorkReport = Readonly<{ signature: string; key: string }>;

export const reportAttempt = (
  existing: PendingWorkReport | undefined,
  payload: WorkReportPayload,
  createKey: () => string,
): PendingWorkReport => {
  const signature = JSON.stringify(payload);
  return existing?.signature === signature ? existing : { signature, key: createKey() };
};
