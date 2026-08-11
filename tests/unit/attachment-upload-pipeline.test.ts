import { describe, expect, it, vi } from "vitest";

import { prepareAndUploadWithConcurrency } from "../../apps/web/src/attachment-upload.js";

describe("attachment upload pipeline", () => {
  it("starts the next preparation while an earlier upload is still in flight", async () => {
    const events: string[] = [];
    let releaseFirstUpload: () => void = () => undefined;
    const firstUpload = new Promise<void>((resolve) => {
      releaseFirstUpload = resolve;
    });

    const run = prepareAndUploadWithConcurrency(
      [1, 2],
      2,
      async (item) => {
        events.push(`prepare:${item}`);
        return item;
      },
      async (item) => {
        events.push(`upload:${item}`);
        if (item === 1) await firstUpload;
        return `uploaded:${item}`;
      },
    );

    await vi.waitFor(() => expect(events).toContain("prepare:2"));
    expect(events.indexOf("prepare:2")).toBeGreaterThan(events.indexOf("upload:1"));

    releaseFirstUpload();
    await expect(run).resolves.toEqual(["uploaded:1", "uploaded:2"]);
  });

  it("keeps active uploads capped at the configured concurrency", async () => {
    let activeUploads = 0;
    let maximumActiveUploads = 0;

    await prepareAndUploadWithConcurrency(
      [1, 2, 3, 4],
      2,
      async (item) => item,
      async (item) => {
        activeUploads += 1;
        maximumActiveUploads = Math.max(maximumActiveUploads, activeUploads);
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
        activeUploads -= 1;
        return item;
      },
    );

    expect(maximumActiveUploads).toBe(2);
  });
});
