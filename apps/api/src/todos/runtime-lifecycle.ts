import { randomUUID } from "node:crypto";

import type { Pool } from "pg";

import { TodoDeliveryWorker, type TodoDeliveryRunResult } from "./delivery-worker.js";
import type { DingTalkTodoProvider } from "./provider.js";
import { TodoTimingService, type TodoTimingRunResult } from "./timing-service.js";
import type { TrustedActorContext } from "../tools/repositories.js";

type Logger = Readonly<{
  info(value: unknown, message?: string): void;
  warn(value: unknown, message?: string): void;
}>;

type DeliveryRunner = Readonly<{
  runOnce(limit?: number): Promise<TodoDeliveryRunResult>;
}>;

type TimingRunner = Readonly<{
  runOnce(actor: TrustedActorContext, limit?: number): Promise<TodoTimingRunResult>;
}>;

export type TodoRuntimeLifecycleOptions = Readonly<{
  enabled: boolean;
  deliveryEnabled?: boolean;
  timingEnabled?: boolean;
  todoPublicBaseUrl?: string;
  runtimeActorId?: string;
  deliveryIntervalMs?: number;
  timingIntervalMs?: number;
  provider?: DingTalkTodoProvider;
  deliveryRunner?: DeliveryRunner;
  timingRunner?: TimingRunner;
  logger: Logger;
}>;

export class TodoRuntimeLifecycle {
  private deliveryTimer: NodeJS.Timeout | null = null;
  private timingTimer: NodeJS.Timeout | null = null;
  private deliveryRun: Promise<void> | null = null;
  private timingRun: Promise<void> | null = null;
  private stopped = true;
  private readonly deliveryWorker: DeliveryRunner;
  private readonly timingService: TimingRunner;
  private readonly deliveryIntervalMs: number;
  private readonly timingIntervalMs: number;
  private readonly deliveryEnabled: boolean;
  private readonly timingEnabled: boolean;

  constructor(
    private readonly database: Pool,
    private readonly options: TodoRuntimeLifecycleOptions,
  ) {
    this.deliveryEnabled = options.deliveryEnabled ?? options.enabled;
    this.timingEnabled = options.timingEnabled ?? options.enabled;
    if (this.deliveryEnabled && !options.deliveryRunner && !options.provider) {
      throw new Error("Todo delivery requires an explicit DingTalk todo provider");
    }
    if (this.deliveryEnabled && !options.deliveryRunner && !options.todoPublicBaseUrl) {
      throw new Error("Todo delivery requires TODO_PUBLIC_BASE_URL");
    }
    if (this.timingEnabled && !options.runtimeActorId) {
      throw new Error("Todo timing requires TODO_RUNTIME_ACTOR_ID");
    }
    this.deliveryWorker = options.deliveryRunner
      ?? new TodoDeliveryWorker(database, options.provider!, options.todoPublicBaseUrl!);
    this.timingService = options.timingRunner ?? new TodoTimingService(database);
    this.deliveryIntervalMs = this.interval(options.deliveryIntervalMs ?? 30_000, "delivery");
    this.timingIntervalMs = this.interval(options.timingIntervalMs ?? 60_000, "timing");
  }

  start(): void {
    if ((!this.deliveryEnabled && !this.timingEnabled) || !this.stopped) return;
    this.stopped = false;
    if (this.deliveryEnabled) {
      this.deliveryTimer = setInterval(() => this.kickDelivery(), this.deliveryIntervalMs);
      this.kickDelivery();
    }
    if (this.timingEnabled) {
      this.timingTimer = setInterval(() => this.kickTiming(), this.timingIntervalMs);
      this.kickTiming();
    }
    this.options.logger.info({
      deliveryEnabled: this.deliveryEnabled,
      timingEnabled: this.timingEnabled,
      deliveryIntervalMs: this.deliveryIntervalMs,
      timingIntervalMs: this.timingIntervalMs,
    }, "todo runtime lifecycle started");
  }

  async stop(): Promise<void> {
    if (this.stopped && !this.deliveryRun && !this.timingRun) return;
    this.stopped = true;
    if (this.deliveryTimer) clearInterval(this.deliveryTimer);
    if (this.timingTimer) clearInterval(this.timingTimer);
    this.deliveryTimer = null;
    this.timingTimer = null;
    await Promise.allSettled([
      this.deliveryRun ?? Promise.resolve(),
      this.timingRun ?? Promise.resolve(),
    ]);
    this.options.logger.info({}, "todo runtime lifecycle stopped");
  }

  private kickDelivery(): void {
    if (this.stopped || this.deliveryRun) return;
    this.deliveryRun = this.runDelivery().finally(() => { this.deliveryRun = null; });
  }

  private kickTiming(): void {
    if (this.stopped || this.timingRun) return;
    this.timingRun = this.runTiming().finally(() => { this.timingRun = null; });
  }

  private async runDelivery(): Promise<void> {
    try {
      const result = await this.deliveryWorker.runOnce();
      this.options.logger.info(result, "todo delivery worker tick completed");
    } catch (error: unknown) {
      this.options.logger.warn({ err: this.safeError(error) }, "todo delivery worker tick failed");
    }
  }

  private async runTiming(): Promise<void> {
    try {
      const actor = await this.resolveRuntimeActor();
      const result = await this.timingService.runOnce(actor);
      this.options.logger.info(result, "todo timing tick completed");
    } catch (error: unknown) {
      this.options.logger.warn({ err: this.safeError(error) }, "todo timing tick failed");
    }
  }

  private async resolveRuntimeActor(): Promise<TrustedActorContext> {
    const result = await this.database.query<{
      actor_id: string;
      actor_roles: string[];
    }>(
      `SELECT user_record.id actor_id,
              array_agg(DISTINCT assignment.role_code ORDER BY assignment.role_code) actor_roles
       FROM app_users user_record
       JOIN identity_mappings identity
         ON identity.user_id=user_record.id AND identity.provider='dingtalk'
        AND identity.active=true AND identity.employed=true
       JOIN access_security_policy policy
         ON policy.policy_key='primary' AND policy.dingtalk_corp_id=identity.corp_id
       JOIN user_role_assignments assignment
         ON assignment.user_id=user_record.id AND assignment.revoked_at IS NULL
       JOIN business_roles role
         ON role.role_code=assignment.role_code AND role.enabled=true
       JOIN role_capabilities capability
         ON capability.role_code=assignment.role_code AND capability.capability='todo:runtime'
       WHERE user_record.id=$1 AND user_record.enabled=true
       GROUP BY user_record.id`,
      [this.options.runtimeActorId],
    );
    const actor = result.rows[0];
    if (!actor) {
      throw new Error("Configured todo runtime actor is not an active authorized employee");
    }
    return {
      actorId: actor.actor_id,
      actorRoles: actor.actor_roles,
      authorizationCapability: "todo:runtime",
      authorizationCapabilities: ["todo:runtime"],
      requestId: `todo-runtime:${randomUUID()}`,
    };
  }

  private interval(value: number, name: string): number {
    if (!Number.isInteger(value) || value < 1_000 || value > 3_600_000) {
      throw new Error(`Todo ${name} interval must be between 1000 and 3600000 milliseconds`);
    }
    return value;
  }

  private safeError(error: unknown): Readonly<{ name: string; message: string }> {
    if (error instanceof Error) {
      return { name: error.name.slice(0, 100), message: error.message.slice(0, 500) };
    }
    return { name: "UnknownError", message: "Unknown todo runtime failure" };
  }
}

