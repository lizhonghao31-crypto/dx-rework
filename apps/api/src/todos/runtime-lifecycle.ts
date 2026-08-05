import type { Pool } from "pg";

import { TodoDeliveryWorker } from "./delivery-worker.js";
import { DisabledDingTalkTodoProvider, type DingTalkTodoProvider } from "./provider.js";
import { TodoTimingService } from "./timing-service.js";
import type { TrustedActorContext } from "../tools/repositories.js";

type Logger = Readonly<{
  info(value: unknown, message?: string): void;
  warn(value: unknown, message?: string): void;
}>;

export type TodoRuntimeLifecycleOptions = Readonly<{
  enabled: boolean;
  appBasePath: string;
  deliveryIntervalMs?: number;
  timingIntervalMs?: number;
  provider?: DingTalkTodoProvider;
  timingActor: TrustedActorContext;
  logger: Logger;
}>;

export class TodoRuntimeLifecycle {
  private deliveryTimer: NodeJS.Timeout | null = null;
  private timingTimer: NodeJS.Timeout | null = null;
  private runningDelivery = false;
  private runningTiming = false;
  private stopped = true;
  private readonly deliveryWorker: TodoDeliveryWorker;
  private readonly timingService: TodoTimingService;
  private readonly deliveryIntervalMs: number;
  private readonly timingIntervalMs: number;

  constructor(database: Pool, private readonly options: TodoRuntimeLifecycleOptions) {
    this.deliveryWorker = new TodoDeliveryWorker(database, options.provider ?? new DisabledDingTalkTodoProvider(), options.appBasePath);
    this.timingService = new TodoTimingService(database);
    this.deliveryIntervalMs = options.deliveryIntervalMs ?? 30_000;
    this.timingIntervalMs = options.timingIntervalMs ?? 60_000;
  }

  start(): void {
    if (!this.options.enabled || !this.stopped) return;
    this.stopped = false;
    this.deliveryTimer = setInterval(() => void this.runDelivery(), this.deliveryIntervalMs);
    this.timingTimer = setInterval(() => void this.runTiming(), this.timingIntervalMs);
    void this.runDelivery();
    void this.runTiming();
    this.options.logger.info({ deliveryIntervalMs: this.deliveryIntervalMs, timingIntervalMs: this.timingIntervalMs }, "todo runtime lifecycle started");
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.deliveryTimer) clearInterval(this.deliveryTimer);
    if (this.timingTimer) clearInterval(this.timingTimer);
    this.deliveryTimer = null;
    this.timingTimer = null;
    this.options.logger.info({}, "todo runtime lifecycle stopped");
  }

  private async runDelivery(): Promise<void> {
    if (this.runningDelivery || this.stopped) return;
    this.runningDelivery = true;
    try {
      const result = await this.deliveryWorker.runOnce();
      this.options.logger.info(result, "todo delivery worker tick completed");
    } catch (error) {
      this.options.logger.warn({ err: error instanceof Error ? { name: error.name, message: error.message } : error }, "todo delivery worker tick failed");
    } finally {
      this.runningDelivery = false;
    }
  }

  private async runTiming(): Promise<void> {
    if (this.runningTiming || this.stopped) return;
    this.runningTiming = true;
    try {
      const result = await this.timingService.runOnce(this.options.timingActor);
      this.options.logger.info(result, "todo timing tick completed");
    } catch (error) {
      this.options.logger.warn({ err: error instanceof Error ? { name: error.name, message: error.message } : error }, "todo timing tick failed");
    } finally {
      this.runningTiming = false;
    }
  }
}
