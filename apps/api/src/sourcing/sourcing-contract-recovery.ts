import type { AcceptanceClockRuntime } from "../acceptance-clock/runtime.js";
import type { SourcingContractService } from "./sourcing-contract-service.js";

type Logger = Pick<Console, "info" | "warn">;
export class SourcingContractRecovery {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private cancellation: AbortController | undefined;
  private stopped = true;
  private cursor: Awaited<ReturnType<SourcingContractService["resumePendingContracts"]>>["cursor"] = null;
  private failures = 0;
  private withoutProgress = 0;
  private lastProgress: string | null = null;

  constructor(
    private readonly contracts: Pick<SourcingContractService, "resumePendingContracts">,
    private readonly logger: Logger,
    private readonly enabled: boolean,
    private readonly acceptanceClock?: AcceptanceClockRuntime,
    private readonly shutdownGraceMs = 5_000,
  ) {}

  start(): void {
    if (!this.enabled || !this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    const cancellation = this.cancellation;
    if (!cancellation) return;
    const grace = setTimeout(() => cancellation.abort(), this.shutdownGraceMs);
    try { await this.running; }
    finally { clearTimeout(grace); }
  }

  private schedule(delay: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      if (this.stopped || this.running) return;
      this.cancellation = new AbortController();
      this.running = this.run(this.cancellation.signal).finally(() => {
        this.running = undefined;
        this.cancellation = undefined;
      });
    }, delay);
    this.timer.unref();
  }

  private async run(signal: AbortSignal): Promise<void> {
    let next = 30_000;
    try {
      const result = await this.contracts.resumePendingContracts(50, {
        cursor: this.cursor, stop: () => this.stopped, signal,
        ...(this.acceptanceClock ? { acceptanceClock: this.acceptanceClock } : {}),
        report: (fields, message) => this.logger.info(fields, message),
      });
      this.cursor = result.cursor;
      this.failures = 0;
      this.withoutProgress = result.candidates > 0 && result.ready === 0 ? this.withoutProgress + 1 : 0;
      if (result.ready > 0) this.lastProgress = new Date().toISOString();
      const state = { ...result, lastProgress: this.lastProgress };
      if (this.withoutProgress >= 2) this.logger.warn(state, "contract recovery found work without producing a ready contract");
      else if (result.candidates > 0) this.logger.info(state, "contract recovery scanned a batch");
      if (this.cursor) next = 1_000;
    } catch {
      if (signal.aborted) return;
      this.failures++;
      next = Math.min(300_000, 30_000 * 2 ** Math.min(4, this.failures - 1));
      this.logger.warn({ nextDelayMs: next, cursor: this.cursor, lastProgress: this.lastProgress }, "contract recovery could not scan the queue");
    } finally {
      this.schedule(next);
    }
  }
}
