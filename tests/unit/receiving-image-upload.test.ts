import { afterEach, describe, expect, it, vi } from "vitest";

import {
  isReceivingImageCandidate,
  normalizeReceivingImageForUpload,
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
});

