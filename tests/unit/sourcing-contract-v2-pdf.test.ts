import { readFile } from "node:fs/promises";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { describe, expect, it } from "vitest";
import { renderSourcingContractPdf, type ContractPdfSnapshot } from "../../apps/api/src/sourcing/sourcing-contract-pdf.js";

const terms = JSON.parse((await readFile("apps/api/migrations/0147_sourcing_contract_input_correction.sql", "utf8"))
  .match(/'(\{"qualityRequirements"[^\n]+\})'::jsonb/)![1]!);
const base: ContractPdfSnapshot = {
  templateVersion: 2,gender: "男装",styleName: "梭织短裤",contractNumber: "DX-WF-20260905-000001",contractDate: "2026-09-05",
  partyAName: "广州市达兴服装制造有限公司",partyAAddress: "广州市白云区江高镇大田高田大街40号401房",
  partyBName: "湖南测试服饰有限公司",partyBAddress: "湖南省测试地址",partyBRepresentative: "陈代表",
  signingPlace: "广州市",payeeName: "测试收款人",bankAccount: "6222000000000000",bankName: "测试开户行",
  estimatedCutPieceSendDate: "2026-08-27",deliveryDate: "2026-09-18",processes: ["车缝+线+包装，回厂装箱+一程运费"],
  totalQuantity: 588,totalAmount: "10584.00",terms,
  lines: [{position: 1,styleNo: "SE20550014",alternateStyleNo: "SEKH260608",color: "黑色",quantity: 588,unitPrice: "18.0000",totalAmount: "10584.00"}],
};

describe("corrected source contract PDF", () => {
  it.each([1, 3, 5, 20])("retains all inputs and original clauses across %i lines with embedded Chinese", async (count) => {
    const snapshot = { ...base, lines: Array.from({length: count}, (_, index) => ({...base.lines[0]!,position: index + 1,styleNo: `SE20550014-${index + 1}`})),totalQuantity: 588 * count,totalAmount: String(10584 * count) };
    const pdf = await renderSourcingContractPdf(snapshot);
    expect(pdf.toString("binary")).toMatch(/\/FontFile[23]/);
    const document = await getDocument({data: new Uint8Array(pdf),useSystemFonts: false}).promise;
    let text = "";
    for (let index = 1; index <= document.numPages; index += 1) {
      const page = await document.getPage(index);
      const content = await page.getTextContent();
      for (const item of content.items) {
        if (!("str" in item)) continue;
        text += item.str;
        expect(item.transform[5]).toBeGreaterThan(15);
        expect(item.transform[4]).toBeGreaterThanOrEqual(31);
        expect(item.transform[4] + item.width).toBeLessThan(565);
      }
    }
    const normalized = text.replace(/\s/g, "");
    for (const expected of [base.partyAName,base.partyAAddress!,base.partyBName,"男装梭织短裤","不含税","工厂发出","到工厂","乙方负责车缝+线+包装，回厂装箱+一程运费，甲方提供样板及面/辅料。","甲方代表：","乙方代表：","签署日期：",`SE20550014-${count}`,"SEKH260608",...Object.values(terms) as string[]]) {
      expect(normalized).toContain(expected.replace(/\s/g, ""));
    }
    expect(normalized).not.toMatch(/大兴价|达兴价格|daxing|88\.8888|平台订单/);
    if (count === 20) expect(document.numPages).toBeGreaterThan(1);
    await document.cleanup();
  }, 20_000);

  it("preserves a long ordered responsibility clause across pages", async () => {
    const processes = Array.from({ length: 20 }, (_, index) => `第${index + 1}项车缝用线及包装责任${"按确认样板执行".repeat(10)}`);
    const pdf = await renderSourcingContractPdf({...base,processes});
    const document = await getDocument({data: new Uint8Array(pdf)}).promise;
    let text = "";
    for (let index = 1; index <= document.numPages; index += 1) {
      const page = await document.getPage(index);
      text += (await page.getTextContent()).items.map((item) => "str" in item ? item.str : "").join("");
    }
    const normalized = text.replace(/\s/g, "").replace(/DX-WF-20260905-000001\d+\/\d+/g, "");
    for (const process of processes) expect(normalized).toContain(process);
    expect(normalized).toContain("甲方提供样板及面/辅料");
    expect(normalized).toContain("本合同有效期为一年");
    await document.cleanup();
  }, 20_000);
});
