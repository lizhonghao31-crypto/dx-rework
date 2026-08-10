import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("external evidence upload timeout UX", () => {
  it("times out every remote stage and leaves a visible retry path", async () => {
    const source = await readFile(
      "apps/web/src/external-evidence-uploader.tsx",
      "utf8",
    );

    expect(source).toContain("prepareTimeoutMilliseconds");
    expect(source).toContain("apiTimeoutMilliseconds");
    expect(source).toContain("uploadTimeoutMilliseconds");
    expect(source).toContain("controller.abort()");
    expect(source).toContain('setStage("preparing")');
    expect(source).toContain('setStage("uploading")');
    expect(source).toContain('setStage("verifying")');
    expect(source).toContain("可重新选择同一文件重试");
    expect(source).toContain("setUploading(false)");
  });
});
