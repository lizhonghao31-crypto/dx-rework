import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { TodoRuntimeLifecycle } from "../../apps/api/src/todos/runtime-lifecycle.js";

const result = {
  claimed: 0,
  sent: 0,
  failed: 0,
  suppressed: 0,
};
const timingResult = {
  claimed: 0,
  overdueCandidates: 0,
  overdueTodos: 0,
  reminders: 0,
  escalations: 0,
  escalationNotifications: 0,
  noLongerDue: 0,
};

const database = {
  query: vi.fn(async () => ({
    rows: [{
      actor_id: "00000000-0000-4000-8000-000000000001",
      actor_roles: ["system_admin"],
    }],
  })),
} as unknown as Pool;

const logger = { info: vi.fn(), warn: vi.fn() };
const tick = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};

describe("TodoRuntimeLifecycle", () => {
  it("stays disabled without a provider and never starts network work in tests", async () => {
    const delivery = { runOnce: vi.fn(async () => result) };
    const timing = { runOnce: vi.fn(async () => timingResult) };
    const lifecycle = new TodoRuntimeLifecycle(database, {
      enabled: false,
      appBasePath: "/",
      deliveryRunner: delivery,
      timingRunner: timing,
      logger,
    });
    lifecycle.start();
    await tick();
    expect(delivery.runOnce).not.toHaveBeenCalled();
    expect(timing.runOnce).not.toHaveBeenCalled();
    await lifecycle.stop();
  });

  it("requires explicit production authority and prevents overlapping ticks", async () => {
    expect(() => new TodoRuntimeLifecycle(database, {
      enabled: true,
      appBasePath: "/",
      runtimeActorId: "00000000-0000-4000-8000-000000000001",
      logger,
    })).toThrow("explicit DingTalk todo provider");

    let releaseDelivery: (() => void) | undefined;
    const delivery = {
      runOnce: vi.fn(() => new Promise<typeof result>((resolve) => {
        releaseDelivery = () => resolve(result);
      })),
    };
    const timing = { runOnce: vi.fn(async () => timingResult) };
    const lifecycle = new TodoRuntimeLifecycle(database, {
      enabled: true,
      appBasePath: "/",
      runtimeActorId: "00000000-0000-4000-8000-000000000001",
      deliveryIntervalMs: 1_000,
      timingIntervalMs: 1_000,
      deliveryRunner: delivery,
      timingRunner: timing,
      logger,
    });
    lifecycle.start();
    lifecycle.start();
    await tick();
    expect(delivery.runOnce).toHaveBeenCalledTimes(1);
    expect(timing.runOnce).toHaveBeenCalledTimes(1);
    expect(timing.runOnce.mock.calls[0]?.[0]).toMatchObject({
      actorId: "00000000-0000-4000-8000-000000000001",
      actorRoles: ["system_admin"],
      authorizationCapability: "todo:runtime",
    });
    const stopping = lifecycle.stop();
    releaseDelivery?.();
    await stopping;
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("fails closed when the configured runtime actor is no longer eligible", async () => {
    const unavailableDatabase = {
      query: vi.fn(async () => ({ rows: [] })),
    } as unknown as Pool;
    const delivery = { runOnce: vi.fn(async () => result) };
    const timing = { runOnce: vi.fn(async () => timingResult) };
    const localLogger = { info: vi.fn(), warn: vi.fn() };
    const lifecycle = new TodoRuntimeLifecycle(unavailableDatabase, {
      enabled: true,
      appBasePath: "/",
      runtimeActorId: "00000000-0000-4000-8000-000000000001",
      deliveryIntervalMs: 1_000,
      timingIntervalMs: 1_000,
      deliveryRunner: delivery,
      timingRunner: timing,
      logger: localLogger,
    });
    lifecycle.start();
    await tick();
    expect(delivery.runOnce).toHaveBeenCalledTimes(1);
    expect(timing.runOnce).not.toHaveBeenCalled();
    expect(localLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.objectContaining({ message: expect.stringContaining("not an active authorized employee") }) }),
      "todo timing tick failed",
    );
    await lifecycle.stop();
  });
});
