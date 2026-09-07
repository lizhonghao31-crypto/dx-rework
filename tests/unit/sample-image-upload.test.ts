import { afterEach, describe, expect, it, vi } from "vitest";
import type * as UploadPreparation from "../../apps/web/src/attachment-upload.js";
import type { SampleUploadApi } from "../../apps/web/src/sample-image-upload.js";
import { uploadSampleImage } from "../../apps/web/src/sample-image-upload.js";
import { SampleRequestError } from "../../apps/web/src/sample-request.js";

vi.mock("../../apps/web/src/attachment-upload.js", async importOriginal => ({
  ...await importOriginal<typeof UploadPreparation>(),
  prepareImageUploadCandidate: vi.fn(async (file: File) => file),
  sha256Hex: vi.fn(async () => "a".repeat(64)),
}));
afterEach(() => vi.unstubAllGlobals());
const source = () => new File(["synthetic fixture"], "receipt.png", { type: "image/png" });
function api(): SampleUploadApi {
  return {
    createIntent: vi.fn<SampleUploadApi["createIntent"]>(async () => ({ attachmentId: "00000000-0000-4000-8000-000000000001", objectKey: "fixture", uploadMethod: "POST", uploadUrl: "https://storage.example.test/upload", uploadFields: { key: "fixture" }, expiresAt: "2026-09-07T00:00:00Z" })),
    finalize: vi.fn<SampleUploadApi["finalize"]>(async () => ({ attachmentId: "00000000-0000-4000-8000-000000000001", filename: "receipt.png", mimeType: "image/png", sizeBytes: 17, sha256: "a".repeat(64), status: "ready", createdAt: "2026-09-07T00:00:00Z" })),
  };
}
describe("sample image upload stages", () => {
  it("sends multipart bytes then confirms the exact attachment before returning it", async () => {
    const client = api(), fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetcher);
    const result = await uploadSampleImage(source(), client);
    expect(client.createIntent).toHaveBeenCalledWith(expect.objectContaining({ filename: "receipt.png", mimeType: "image/png", sha256: "a".repeat(64) }));
    expect(client.finalize).toHaveBeenCalledWith(result.attachmentId);
    const init = fetcher.mock.calls[0]![1] as RequestInit;
    expect(init.credentials).toBe("omit");
    expect(init.headers).toBeUndefined();
    expect((init.body as FormData).get("file")).toBeInstanceOf(File);
    expect((init.body as FormData).get("key")).toBe("fixture");
  });

  it("identifies an intent failure and does not send bytes or finalize", async () => {
    const client = api(), fetcher = vi.fn();
    vi.mocked(client.createIntent).mockRejectedValue(new SampleRequestError("Request validation failed", "VALIDATION_ERROR", 400));
    vi.stubGlobal("fetch", fetcher);
    await expect(uploadSampleImage(source(), client)).rejects.toThrow("上传申请失败：请求资料校验未通过");
    expect(fetcher).not.toHaveBeenCalled(); expect(client.finalize).not.toHaveBeenCalled();
  });

  it("stops before finalize on transfer failure and succeeds on an explicit retry", async () => {
    const client = api(), fetcher = vi.fn().mockResolvedValueOnce(new Response(null, { status: 503 })).mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetcher);
    await expect(uploadSampleImage(source(), client)).rejects.toThrow("图片上传失败");
    expect(client.finalize).not.toHaveBeenCalled();
    await expect(uploadSampleImage(source(), client)).resolves.toMatchObject({ status: "ready" });
    expect(client.createIntent).toHaveBeenCalledTimes(2);
    expect(client.finalize).toHaveBeenCalledTimes(1);
  });

  it("does not publish an unfinished attachment after finalize failure", async () => {
    const client = api(); vi.stubGlobal("fetch", async () => new Response(null, { status: 204 }));
    vi.mocked(client.finalize).mockRejectedValueOnce(new SampleRequestError("Request validation failed", "VALIDATION_ERROR", 400));
    await expect(uploadSampleImage(source(), client)).rejects.toThrow("上传确认失败：请求资料校验未通过");
    vi.mocked(client.finalize).mockResolvedValueOnce({ ...(await api().finalize("fixture")), status: "pending" });
    await expect(uploadSampleImage(source(), client)).rejects.toThrow("图片尚未确认完成");
  });
});
