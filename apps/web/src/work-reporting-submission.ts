export type WorkReportPayload = Readonly<{
  expectedOrderVersion: number;
  actualQuantity: number;
  completedAt: string;
}>;
export type WorkTaskPayload = Readonly<{
  expectedOrderVersion: number;
  configurationItemId: string;
  mode: "individual" | "collective";
  members: ReadonlyArray<Readonly<{ personId: string }>>;
}>;
export type PendingWorkReport = Readonly<{ signature: string; key: string }>;
export type PendingWorkTask = Readonly<{ signature: string; key: string }>;

const attempt = <T,>(
  existing: Readonly<{ signature: string; key: string }> | undefined,
  payload: T,
  createKey: () => string,
): Readonly<{ signature: string; key: string }> => {
  const signature = JSON.stringify(payload);
  return existing?.signature === signature ? existing : { signature, key: createKey() };
};

export const reportAttempt = (
  existing: PendingWorkReport | undefined,
  payload: WorkReportPayload,
  createKey: () => string,
): PendingWorkReport => {
  return attempt(existing, payload, createKey);
};

export const taskAttempt = (
  existing: PendingWorkTask | undefined,
  payload: WorkTaskPayload,
  createKey: () => string,
): PendingWorkTask => attempt(existing, payload, createKey);

const pad = (value: number): string => String(value).padStart(2, "0");

export const localDateTimeValue = (date: Date = new Date()): string =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
