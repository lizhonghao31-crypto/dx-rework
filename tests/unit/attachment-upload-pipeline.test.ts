import { describe, expect, it, vi } from "vitest";

import {
  prepareAndUploadWithConcurrency,
  qcUploadConcurrency,
  SMALL_IMAGE_DIRECT_UPLOAD_BYTES,
  shouldCompressImageBeforeUpload,
} from "../../apps/web/src/attachment-upload.js";

describe("attachment upload pipeline", () => {
  it("uploads small images directly and only compresses larger supported images", () => {
    expect(shouldCompressImageBeforeUpload({
      type: "image/jpeg",
      size: 840 * 1024,
    })).toBe(false);
    expect(shouldCompressImageBeforeUpload({
      type: "image/jpeg",
      size: SMALL_IMAGE_DIRECT_UPLOAD_BYTES,
    })).toBe(false);
    expect(shouldCompressImageBeforeUpload({
      type: "image/jpeg",
      size: SMALL_IMAGE_DIRECT_UPLOAD_BYTES + 1,
    })).toBe(true);
    expect(shouldCompressImageBeforeUpload({
      type: "application/pdf",
      size: SMALL_IMAGE_DIRECT_UPLOAD_BYTES + 1,
    })).toBe(false);
  });

  it("opens three upload lanes on ordinary networks while preserving weak-network backpressure", () => {
    expect(qcUploadConcurrency()).toBe(3);
    expect(qcUploadConcurrency({ effectiveType: "4g" })).toBe(3);
    expect(qcUploadConcurrency({ effectiveType: "3g" })).toBe(2);
    expect(qcUploadConcurrency({ effectiveType: "2g" })).toBe(1);
  });

  it("starts an upload before a different file has finished preparing", async () => {
    const events: string[] = [];
    let releaseSecondPreparation: () => void = () => undefined;
    const secondPreparation = new Promise<number>((resolve) => {
      releaseSecondPreparation = resolve;
    });

    const run = prepareAndUploadWithConcurrency(
      [1, 2],
      2,
      async (item) => {
        events.push(`prepare:${item}`);
        return item === 2 ? secondPreparation : item;
      },
      async (item) => {
        events.push(`upload:${item}`);
        return `uploaded:${item}`;
      },
    );

    await vi.waitFor(() => expect(events).toContain("upload:1"));
    expect(events).toContain("prepare:2");
    expect(events).not.toContain("upload:2");

    releaseSecondPreparation(2);
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

  it("forwards an upload failure instead of resolving a partial batch", async () => {
    await expect(prepareAndUploadWithConcurrency(
      [1],
      2,
      async (item) => item,
      async () => {
        throw new Error("上传失败");
      },
    )).rejects.toThrow("上传失败");
  });
});
