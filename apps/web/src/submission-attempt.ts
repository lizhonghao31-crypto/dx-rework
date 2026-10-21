import { submissionFailure } from "./submission-validation.js";

export const SUBMISSION_RECOVERY_WINDOW_MS=23*60*60*1000;

type Attempt = { execute: () => Promise<void>; startedAt: number };
export type SubmissionOutcome =
  | { kind: "success" | "busy" | "needs-recovery" | "expired" }
  | { kind: "failure"; failure: ReturnType<typeof submissionFailure>; uncertain: boolean; confirmed: boolean };

/** Keeps one immutable caller snapshot until the write is confirmed or definitely rejected. */
export class SubmissionAttempt {
  private pending: Attempt | null = null;
  private active = false;
  constructor(private readonly now: () => number = Date.now) {}
  get hasPending(): boolean { return this.pending !== null; }
  markConfirmed(): void { this.pending = null; }
  async run(execute: () => Promise<void>, retry = false): Promise<SubmissionOutcome> {
    if (this.active) return { kind: "busy" };
    if (this.pending && !retry) return { kind: "needs-recovery" };
    // Server idempotency retention is 24h. Do not initiate recovery near or beyond expiry.
    if (retry && this.pending && this.now() - this.pending.startedAt >= SUBMISSION_RECOVERY_WINDOW_MS) return { kind: "expired" };
    const operation = retry && this.pending ? this.pending.execute : execute;
    this.pending ??= { execute: operation, startedAt: this.now() };
    this.active = true;
    try {
      await operation();
      this.pending = null;
      return { kind: "success" };
    } catch (error) {
      const failure = submissionFailure(error);
      const confirmed = this.pending === null;
      // A refusal on a recovery attempt cannot disprove the earlier write.
      const uncertain = !confirmed && (retry || failure.uncertain);
      if (!uncertain) this.pending = null;
      return { kind: "failure", failure, uncertain, confirmed };
    } finally { this.active = false; }
  }
  retry(): Promise<SubmissionOutcome> {
    return this.pending ? this.run(this.pending.execute, true) : Promise.resolve({ kind: "success" });
  }
}
