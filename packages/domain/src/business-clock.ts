/** Business time is scoped by a trusted order/source identity, never a request date. */
export type BusinessTimeScope = Readonly<{ kind: "order" | "source"; id: string }>;
export type BusinessTime = Readonly<{ now: string; scenarioId: string | null; revision: number }>;
export interface BusinessClock {
  read(scope: BusinessTimeScope): Promise<BusinessTime>;
}
/** Production wiring uses this clock. Authentication, audit and timeouts must not use BusinessClock. */
export class SystemBusinessClock implements BusinessClock {
  async read(scope: BusinessTimeScope): Promise<BusinessTime> {
    if (!scope.id.trim()) throw new Error("Business clock requires an explicit scope");
    return { now: new Date().toISOString(), scenarioId: null, revision: 0 };
  }
}
export function validateBusinessTime(time: BusinessTime): BusinessTime {
  if (!/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(time.now) || !Number.isFinite(Date.parse(time.now)) || !Number.isSafeInteger(time.revision) || time.revision < 0
    || (time.scenarioId === null && time.revision !== 0) || (time.scenarioId !== null && (!time.scenarioId || time.revision < 1))) {
    throw new Error("Invalid business clock observation");
  }
  return { ...time };
}
