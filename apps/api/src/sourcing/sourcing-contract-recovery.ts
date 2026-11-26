import type { AcceptanceClockRuntime } from "../acceptance-clock/runtime.js";
import type { SourcingContractService } from "./sourcing-contract-service.js";

type Logger = Pick<Console, "info" | "warn">;
export class SourcingContractRecovery {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
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
  ) {}

  start(): void {
    if (!this.enabled || !this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.running;
  }

  private schedule(delay: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      if (this.stopped || this.running) return;
      this.running = this.run().finally(() => { this.running = undefined; });
    }, delay);
    this.timer.unref();
  }

  private async run(): Promise<void> {
    let next = 30_000;
    try {
      const result = await this.contracts.resumePendingContracts(50, {
        cursor: this.cursor, stop: () => this.stopped,
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
      this.failures++;
      next = Math.min(300_000, 30_000 * 2 ** Math.min(4, this.failures - 1));
      this.logger.warn({ nextDelayMs: next, cursor: this.cursor, lastProgress: this.lastProgress }, "contract recovery could not scan the queue");
    } finally {
      this.schedule(next);
    }
  }
}
