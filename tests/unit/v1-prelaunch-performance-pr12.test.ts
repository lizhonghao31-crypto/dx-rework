import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { mapWithConcurrency } from "../../apps/web/src/concurrency.js";

describe("1.0 prelaunch submission performance", () => {
  it("bounds concurrent mutations and preserves result order", async () => {
    let active = 0;
    let peak = 0;
    const results = await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7], 3, async (value) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return value * 10;
    });

    expect(peak).toBe(3);
    expect(results).toEqual([10, 20, 30, 40, 50, 60, 70]);
  });

  it("keeps empty batches side-effect free", async () => {
    let calls = 0;
    const results = await mapWithConcurrency([], 3, async () => {
      calls += 1;
      return "unexpected";
    });
    expect(results).toEqual([]);
    expect(calls).toBe(0);
  });

  it("stops scheduling after a failure and waits for in-flight work", async () => {
    const started: number[] = [];
    const finished: number[] = [];
    await expect(mapWithConcurrency([1, 2, 3, 4], 2, async (value) => {
      started.push(value);
      if (value === 2) throw new Error("failed");
      await new Promise((resolve) => setTimeout(resolve, 5));
      finished.push(value);
      return value;
    })).rejects.toThrow("failed");

    expect(started).toEqual([1, 2]);
    expect(finished).toEqual([1]);
  });

  it("uses controlled concurrency and removes redundant post-submit reads", async () => {
    const [assignment, receiving, review] = await Promise.all([
      readFile("apps/web/src/work-reporting-form.tsx", "utf8"),
      readFile("apps/web/src/receiving-page.tsx", "utf8"),
      readFile("apps/web/src/whole-order-review-panel.tsx", "utf8"),
    ]);

    expect(assignment).toContain("mapWithConcurrency(memberIds, 3");
    expect(assignment).toContain("tasks: [...data.tasks, ...assigned]");
    expect(assignment).not.toContain("if (canReadTasks) await reload()");
    expect(assignment).toContain("setData(confirmed)");
    expect(receiving).toContain("mapWithConcurrency(images, 2");
    expect(review).toContain("if (applyResult) applyResult(result)");
    expect(review).toContain("applyOverview,");
  });
});
