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
    const recovery=await readFile("apps/web/src/attachment-upload-recovery.ts","utf8");
    expect(recovery).toContain("45_000");
    expect(recovery).toContain("controller.abort()");
    expect(source).toContain("uploadAttachmentWithRecovery");
    expect(source).toContain("controller.abort()");
    expect(source).toContain('setStage("preparing")');
    expect(source).toContain("phase==='finalize'?'verifying':'uploading'");
    expect(source).toContain("重试未完成附件");
    expect(source).toContain("已成功部分保留");
    expect(source).toContain("setFailedFile(activeFileName)");
    expect(source).toContain("setUploading(false)");
  });
});
