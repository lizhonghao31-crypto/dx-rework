import { afterEach, describe, expect, it, vi } from "vitest";
import { INVALID_DECLARED_IMAGE_MESSAGE } from "../../apps/web/src/attachment-upload.js";
import { preparePatternMaterial, uploadPatternMaterial } from "../../apps/web/src/pattern-material-upload.js";

describe("pattern original material uploads", () => {
  afterEach(() => vi.unstubAllGlobals());
  const jpeg = () => new File([new Uint8Array([255,216,255,224,1,2,3])], "制作资料.jpg", { type: "image/jpeg" });
  it("corrects empty or wrong MIME and extension without changing original bytes", async () => {
    const bytes = new Uint8Array([137,80,78,71,13,10,26,10,5,6,7,8]);
    for (const type of ["", "image/jpeg", "application/octet-stream"]) {
      const source = new File([bytes], "微信图片.jpg", { type, lastModified: 123 });
      const result = await preparePatternMaterial(source);
      expect(result.name).toBe("微信图片.png"); expect(result.type).toBe("image/png");
      expect(new Uint8Array(await result.arrayBuffer())).toEqual(bytes);
      expect(result.lastModified).toBe(123);
    }
    const original = jpeg(); expect(await preparePatternMaterial(original)).toBe(original);
    const pdf = new File(["%PDF-1.7\noriginal"], "制作单.pdf", { type: "application/pdf" });
    expect(await preparePatternMaterial(pdf)).toBe(pdf);
  });
  it("rejects empty files and unsupported documents before requesting an upload", async () => {
    const upload = vi.fn();
    await expect(uploadPatternMaterial(new File([], "empty.jpg"), upload)).rejects.toThrow("文件为空");
    await expect(uploadPatternMaterial(new File(["invalid"], "bad.pdf", { type: "application/pdf" }), upload)).rejects.toThrow("请选择可读取");
    expect(upload).not.toHaveBeenCalled();
  });
  it("retries validator-rejected images once at full resolution and does not retry access/network errors", async () => {
    const close = vi.fn(), canvas = { width: 0, height: 0, getContext: () => ({ drawImage: vi.fn() }), toBlob: (callback: BlobCallback, type: string) => callback(new Blob(["normalized"], { type })) };
    vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 6000, height: 4000, close })));
    vi.stubGlobal("document", { createElement: () => canvas });
    const upload = vi.fn().mockRejectedValueOnce(new Error(INVALID_DECLARED_IMAGE_MESSAGE)).mockResolvedValueOnce("ready");
    await expect(uploadPatternMaterial(jpeg(), upload)).resolves.toBe("ready");
    expect(upload).toHaveBeenCalledTimes(2);
    expect(upload.mock.calls[1]![0]).toMatchObject({ type: "image/png", name: "制作资料.png" });
    expect([canvas.width, canvas.height]).toEqual([6000,4000]);
    expect(close).toHaveBeenCalledOnce();
    const denied = vi.fn().mockRejectedValue(new Error("FORBIDDEN"));
    await expect(uploadPatternMaterial(jpeg(), denied)).rejects.toThrow("FORBIDDEN");
    expect(denied).toHaveBeenCalledOnce();
    const invalid = vi.fn().mockRejectedValue(new Error(INVALID_DECLARED_IMAGE_MESSAGE));
    await expect(uploadPatternMaterial(jpeg(), invalid)).rejects.toThrow("图片内容无法读取");
    expect(invalid).toHaveBeenCalledTimes(2);
  });
});
