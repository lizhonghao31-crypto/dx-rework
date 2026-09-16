import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { describe, expect, it } from "vitest";
import { renderSourcingContractPdf, type ContractPdfSnapshot } from "../../apps/api/src/sourcing/sourcing-contract-pdf.js";

const snapshot: ContractPdfSnapshot = {
  templateVersion: 2,
  gender: "男装",
  styleName: "梭织短裤",
  contractNumber: "DX-WF-20260916-000001",
  contractDate: "2026-09-16",
  partyAName: "广州市达兴服装制造有限公司",
  partyAAddress: "广州市白云区江高镇大田高田大街40号401房",
  partyBName: "衡南县正好服饰加工厂（个人独资）",
  partyBAddress: "湖南省衡阳市衡南县云集街道测试地址",
  partyBRepresentative: "李代表",
  payeeName: "测试收款人",
  bankAccount: "6222000000000000",
  bankName: "测试银行",
  signingPlace: "广州市",
  estimatedCutPieceSendDate: "2026-09-20",
  deliveryDate: "2026-09-30",
  processes: ["车缝+线+包装", "回厂装箱+一程运费"],
  totalQuantity: 170,
  totalAmount: "1837.70",
  lines: [
    { position: 1, styleNo: "TEST-A", alternateStyleNo: null, color: "黑色", quantity: 100, unitPrice: "12.35", totalAmount: "1235.00" },
    { position: 2, styleNo: "TEST-B", alternateStyleNo: "ALT-B", color: "白色", quantity: 70, unitPrice: "8.61", totalAmount: "602.70" },
  ],
  terms: {
    qualityRequirements: "1. 乙方开货前必须做一件产前板经甲方确认才可以开货。\n2. 乙方按甲方确认要求进行生产。",
    delayPenalty: "如上表约定执行。",
    logistics: "甲乙双方各负责一程运费。",
    reasonableLoss: "允许按定单数量+-1%。",
    defectRate: "次品按双方确认事实处理。",
    payment: "按双方约定周期结款。",
    effectiveness: "双方签字盖章后生效。",
    validity: "本合同有效期为一年。",
  },
};

type PositionedText = Readonly<{ text: string; x: number; y: number; width: number; page: number }>;

const normalized = (value: string): string => value.replace(/\s/g, "");

describe("sourcing contract PDF presentation", () => {
  it("centers the heading and metadata, and separates the two signature columns", async () => {
    const pdf = await renderSourcingContractPdf(snapshot);
    const document = await getDocument({ data: new Uint8Array(pdf), useSystemFonts: false }).promise;
    const items: PositionedText[] = [];
    let pageWidth = 0;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      pageWidth ||= page.getViewport({ scale: 1 }).width;
      const content = await page.getTextContent();
      for (const item of content.items) {
        if (!("str" in item)) continue;
        items.push({ text: item.str, x: item.transform[4], y: item.transform[5], width: item.width, page: pageNumber });
      }
    }
    const find = (text: string): PositionedText => {
      const item = items.find((candidate) => normalized(candidate.text).includes(normalized(text)));
      expect(item, `missing PDF text: ${text}`).toBeTruthy();
      return item!;
    };
    const title = find("服装加工合同");
    const metadata = find("合同编号：DX-WF-20260916-000001");
    expect(Math.abs(title.x + title.width / 2 - pageWidth / 2)).toBeLessThan(8);

    // PDF.js may split one visually centered metadata line into several text items.
    // Verify the visual row as a whole instead of treating its first fragment as the line width.
    const metadataRow = items.filter((item) => (
      item.page === metadata.page && Math.abs(item.y - metadata.y) < 2
    ));
    const metadataLeft = Math.min(...metadataRow.map((item) => item.x));
    const metadataRight = Math.max(...metadataRow.map((item) => item.x + item.width));
    expect(Math.abs((metadataLeft + metadataRight) / 2 - pageWidth / 2)).toBeLessThan(8);
    expect(normalized(metadataRow.map((item) => item.text).join("")))
      .toContain(normalized("合同编号：DX-WF-20260916-000001生成日期：2026-09-16签订地点：广州市"));

    const partyA = find("甲方（盖章）");
    const partyB = find("乙方（盖章）");
    expect(partyA.page).toBe(partyB.page);
    expect(Math.abs(partyA.y - partyB.y)).toBeLessThan(3);
    expect(partyA.x).toBeLessThan(pageWidth / 2 - 20);
    expect(partyB.x).toBeGreaterThan(pageWidth / 2 + 10);

    const allText = normalized(items.map((item) => item.text).join(""));
    expect(allText).toContain(normalized("二、乙方负责车缝+线+包装、回厂装箱+一程运费，甲方提供样板及面/辅料。"));
    expect(allText).toContain(normalized("三、质量要求："));
    expect(allText).toContain(normalized("甲方代表：________________"));
    expect(allText).toContain(normalized("银行账号：6222000000000000"));
    expect(allText).not.toMatch(/大兴价|达兴价格|daxing/i);
    await document.cleanup();
  }, 20_000);
});
