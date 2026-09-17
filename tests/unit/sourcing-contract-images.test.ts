import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { CreateSourcingCaseSchema } from "../../packages/contracts/src/sourcing.js";
import { normalizeSourcingContractImage, renderSourcingContractPdf, sourcingContractFingerprint, type ContractPdfSnapshot } from "../../apps/api/src/sourcing/sourcing-contract-pdf.js";

const originalTerms = JSON.parse((await readFile("apps/api/migrations/0147_sourcing_contract_input_correction.sql", "utf8"))
  .match(/'(\{"qualityRequirements"[^\n]+\})'::jsonb/)![1]!);
const terms = { ...originalTerms, qualityRequirements: originalTerms.qualityRequirements.replace("费用有乙方承担", "费用由乙方承担") };
const base: ContractPdfSnapshot = {
  templateVersion: 3, gender: "女装", styleName: "梭织短裤", contractNumber: "DX-WF-20260917-000001", contractDate: "2026-09-17",
  partyAName: "广州市达兴服装制造有限公司", partyAAddress: "广州市白云区江高镇大田高田大街40号401房",
  partyBName: "测试服饰有限公司", partyBAddress: "湖南省测试地址", partyBRepresentative: "陈代表",
  signingPlace: "广州市", payeeName: "测试收款人", bankAccount: "6222000000000000", bankName: "测试开户行",
  estimatedCutPieceSendDate: "2026-10-01", deliveryDate: "2026-10-10", processes: ["车缝、包装、运输"],
  totalQuantity: 588, totalAmount: "10584.00", terms,
  lines: [{ position: 1, styleNo: "SE20550014", alternateStyleNo: "TEMP260608", color: "黑色", quantity: 588, unitPrice: "18.0000", totalAmount: "10584.00" }],
};

describe("style images in sourcing contracts", () => {
  it("requires every line picture to be included in the order's uploaded evidence", () => {
    const imageAttachmentId = randomUUID();
    const order = { gender: "女装", styleName: "短裤", estimatedCutPieceSendDate: "2026-10-01", deliveryDate: "2026-10-10",
      lineItems: [{ alternateStyleNo: "TEMP", color: "黑", quantity: 10, imageAttachmentId }], daxingUnitPrice: "10", attachmentIds: [imageAttachmentId] };
    expect(CreateSourcingCaseSchema.safeParse(order).success).toBe(true);
    expect(CreateSourcingCaseSchema.safeParse({ ...order, attachmentIds: [randomUUID()] }).success).toBe(false);
    expect(CreateSourcingCaseSchema.safeParse({ ...order, attachmentIds: Array.from({ length: 20 }, (_, i) => i ? randomUUID() : imageAttachmentId) }).success).toBe(true);
    expect(CreateSourcingCaseSchema.safeParse({ ...order, attachmentIds: Array.from({ length: 21 }, (_, i) => i ? randomUUID() : imageAttachmentId) }).success).toBe(false);
  });

  it.each(["png", "jpeg", "webp"] as const)("normalizes %s images to bounded JPEGs", async (format) => {
    const original = await sharp({ create: { width: 1200, height: 800, channels: 4, background: "#426d9f80" } }).toFormat(format).toBuffer();
    const image = await normalizeSourcingContractImage(original);
    expect(await sharp(image).metadata()).toMatchObject({ format: "jpeg", width: 600, height: 400, channels: 3 });
  });

  it.each([1, 3, 20])("places %i pictures in their rows with adjacent delivery dates and complete clauses", async (count) => {
    const imageBytes = await normalizeSourcingContractImage(await sharp({ create: { width: 120, height: 180, channels: 3, background: "#43688f" } }).png().toBuffer());
    const snapshot = { ...base, lines: Array.from({ length: count }, (_, index) => ({ ...base.lines[0]!, position: index + 1, styleNo: `SE20550014-${index + 1}`, imageBytes })), totalQuantity: 588 * count, totalAmount: String(10584 * count) };
    const document = await getDocument({ data: new Uint8Array(await renderSourcingContractPdf(snapshot)), useSystemFonts: false }).promise;
    let text = "", pictures = 0, headers = 0;
    for (let index = 1; index <= document.numPages; index += 1) {
      const page = await document.getPage(index);
      const items = (await page.getTextContent()).items.filter((item) => "str" in item);
      for (const item of items) {
        text += item.str;
        expect(item.transform[5]).toBeGreaterThan(15);
        expect(item.transform[4]).toBeGreaterThanOrEqual(31);
        expect(item.transform[4] + item.width).toBeLessThan(565);
      }
      const send = items.find(item => item.str === "发裁片时间"), delivery = items.find(item => item.str === "货期");
      if (send && delivery) {
        headers += 1;
        expect(delivery.transform[4]).toBeGreaterThan(send.transform[4]);
        expect(Math.abs(delivery.transform[5] - send.transform[5])).toBeLessThan(1);
        expect(items.filter(item => item.transform[4] > send.transform[4] && item.transform[4] < delivery.transform[4] && Math.abs(item.transform[5] - send.transform[5]) < 1)).toHaveLength(0);
      }
      const operations = await page.getOperatorList();
      pictures += operations.fnArray.filter(operation => operation === OPS.paintImageXObject || operation === OPS.paintInlineImageXObject).length;
    }
    const normalized = text.replace(/\s/g, "");
    expect(pictures).toBe(count);
    expect(headers).toBeGreaterThan(0);
    expect(normalized).toContain(`SE20550014-${count}`);
    expect(normalized).toContain("费用由乙方承担");
    expect(normalized).not.toMatch(/费用有乙方承担|预算价|达兴价|裁床工序|cuttingProcess|daxing/);
    expect(normalized).toContain("乙方代表：陈代表");
    if (count === 20) { expect(document.numPages).toBeGreaterThan(2); expect(headers).toBeGreaterThan(1); }
    await document.cleanup();
  }, 20_000);

  it("includes the picture digest in the immutable fingerprint without embedding its bytes", () => {
    const first = { ...base, lines: [{ ...base.lines[0]!, imageBytes: Buffer.from("image A") }] };
    const second = { ...base, lines: [{ ...base.lines[0]!, imageBytes: Buffer.from("image B") }] };
    expect(sourcingContractFingerprint(first)).not.toBe(sourcingContractFingerprint(second));
    expect(sourcingContractFingerprint({ ...first, lines: [{ ...first.lines[0]!, imageSha256: "frozen-original" }] }))
      .toBe(sourcingContractFingerprint({ ...second, lines: [{ ...second.lines[0]!, imageSha256: "frozen-original" }] }));
  });
});
