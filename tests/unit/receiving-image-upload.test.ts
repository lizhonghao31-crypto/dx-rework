import { afterEach, describe, expect, it, vi } from "vitest";

import {
  INVALID_DECLARED_IMAGE_MESSAGE,
  INVALID_DECLARED_IMAGE_MESSAGE_ZH,
  isReceivingImageCandidate,
  normalizeReceivingImageForUpload,
  uploadImageWithNormalizationRetry,
} from "../../apps/web/src/attachment-upload.js";

class BrowserFile extends Blob {
  readonly name: string;
  readonly lastModified: number;

  constructor(parts: BlobPart[], name: string, options: FilePropertyBag = {}) {
    super(parts, options);
    this.name = name;
    this.lastModified = options.lastModified ?? Date.now();
  }
}

describe("receiving image normalization", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("accepts browser image candidates such as WeChat HEIC while rejecting non-images", () => {
    expect(isReceivingImageCandidate({ type: "image/heic" })).toBe(true);
    expect(isReceivingImageCandidate({ type: "image/heif" })).toBe(true);
    expect(isReceivingImageCandidate({ type: "application/pdf" })).toBe(false);
  });

  it("decodes and re-encodes receiving evidence into validator-safe WebP", async () => {
    const close = vi.fn();
    const drawImage = vi.fn();
    const canvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => ({ drawImage })),
      toBlob: vi.fn((resolve: BlobCallback, type: string) => {
        resolve(new Blob(["normalized"], { type }));
      }),
    };
    vi.stubGlobal("File", BrowserFile);
    vi.stubGlobal("createImageBitmap", vi.fn(async () => ({
      width: 3000,
      height: 1500,
      close,
    })));
    vi.stubGlobal("document", {
      createElement: vi.fn(() => canvas),
    });

    const source = new BrowserFile(["wechat"], "微信图片.jpeg", {
      type: "image/jpeg",
      lastModified: 123,
    }) as File;
    const normalized = await normalizeReceivingImageForUpload(source);

    expect(normalized.name).toBe("微信图片.webp");
    expect(normalized.type).toBe("image/webp");
    expect(normalized.lastModified).toBe(123);
    expect(canvas.width).toBe(2048);
    expect(canvas.height).toBe(1024);
    expect(drawImage).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it.each([INVALID_DECLARED_IMAGE_MESSAGE, INVALID_DECLARED_IMAGE_MESSAGE_ZH])("retries a MIME-mismatched QC image with normalized WebP bytes (%s)", async message => {
    const canvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => ({ drawImage: vi.fn() })),
      toBlob: vi.fn((resolve: BlobCallback, type: string) => {
        resolve(new Blob(["normalized"], { type }));
      }),
    };
    vi.stubGlobal("File", BrowserFile);
    vi.stubGlobal("createImageBitmap", vi.fn(async () => ({
      width: 1200,
      height: 800,
      close: vi.fn(),
    })));
    vi.stubGlobal("document", { createElement: vi.fn(() => canvas) });

    const source = new BrowserFile(["wechat"], "微信群图片.jpg", {
      type: "image/jpeg",
    }) as File;
    const upload = vi.fn()
      .mockRejectedValueOnce(new Error(message))
      .mockResolvedValueOnce("attachment-1");

    await expect(uploadImageWithNormalizationRetry(source, source, upload))
      .resolves.toBe("attachment-1");
    expect(upload).toHaveBeenCalledTimes(2);
    expect(upload.mock.calls[1]?.[0]).toMatchObject({
      name: "微信群图片.webp",
      type: "image/webp",
    });
    const invalid = vi.fn().mockRejectedValue(new Error(message));
    await expect(uploadImageWithNormalizationRetry(source, source, invalid)).rejects.toThrow("图片格式无法识别，请重新选择图片");
    expect(invalid).toHaveBeenCalledTimes(2);
    const denied = vi.fn().mockRejectedValue(new Error("FORBIDDEN"));
    await expect(uploadImageWithNormalizationRetry(source, source, denied)).rejects.toThrow("FORBIDDEN");
    expect(denied).toHaveBeenCalledOnce();
  });
});
