import { createHash } from "node:crypto";
import PDFDocument from "pdfkit";
import sharp from "sharp";
import { SourcingNewUnitPriceSchema } from "@dx-rework/contracts";
import { formatBusinessDecimal } from "@dx-rework/contracts/business-display";

// Never round a historic four-place price when re-rendering its saved facts.
export const formatSourcingContractPrice = (value: string): string =>
  SourcingNewUnitPriceSchema.safeParse(value).success ? formatBusinessDecimal(value) : value;


export const normalizeSourcingContractImage = async (bytes: Buffer): Promise<Buffer> => sharp(bytes,{limitInputPixels:40_000_000})
  .rotate().resize({width:600,height:600,fit:"inside",withoutEnlargement:true})
  .flatten({background:"#ffffff"}).jpeg({quality:80}).toBuffer();

export type ContractPdfLine = Readonly<{
  imageAttachmentId?: string | null | undefined;
  imageSha256?: string | undefined;
  imageBytes?: Buffer;
  position: number;
  styleNo: string;
  alternateStyleNo: string | null;
  color: string | null;
  quantity: number;
  unitPrice: string;
  totalAmount: string;
}>;

export type ContractPdfSnapshot = Readonly<{
  templateVersion?: number;
  gender?: string;
  styleName?: string;
  partyAAddress?: string;
  contractTitle?: string | undefined;
  partyARepresentative?: string | undefined;
  partyASigningDate?: string | undefined;
  partyBSigningDate?: string | undefined;
  contractNumber: string;
  contractDate: string;
  partyAName: string;
  partyBName: string;
  partyBAddress: string;
  partyBRepresentative: string;
  payeeName: string;
  bankAccount: string;
  bankName: string;
  signingPlace: string;
  estimatedCutPieceSendDate: string;
  deliveryDate: string;
  processes: readonly string[];
  lines: readonly ContractPdfLine[];
  totalQuantity: number;
  totalAmount: string;
  terms: Readonly<Record<string, string>>;
}>;

const utf16Hex = (value: string): string => {
  const bytes: number[] = [];
  for (const character of value.normalize("NFC")) {
    const code = character.codePointAt(0) ?? 0x3f;
    if (code > 0xffff) {
      bytes.push(0, 0x3f);
    } else {
      bytes.push(code >> 8, code & 0xff);
    }
  }
  return Buffer.from(bytes).toString("hex").toUpperCase();
};

const wrapPdfLine = (value: string): string[] => {
  const characters = [...value];
  const lines: string[] = [];
  for (let index = 0; index < characters.length; index += 42) {
    lines.push(characters.slice(index, index + 42).join(""));
  }
  return lines.length ? lines : [""];
};

const contractTextLines = (snapshot: ContractPdfSnapshot): string[] => [
  snapshot.contractTitle ?? "外发服装加工合同",
  `合同编号：${snapshot.contractNumber}`,
  `合同日期：${snapshot.contractDate}    签订地点：${snapshot.signingPlace}`,
  `甲方：${snapshot.partyAName}`,
  `乙方：${snapshot.partyBName}`,
  `乙方地址：${snapshot.partyBAddress}    代表：${snapshot.partyBRepresentative}`,
  "加工明细",
  ...snapshot.lines.flatMap((line) => [
    `${String(line.position).padStart(2, "0")}  款号 ${line.styleNo}${line.alternateStyleNo ? ` / 备用款号 ${line.alternateStyleNo}` : ""} / 颜色 ${line.color ?? "未维护"}`,
    `数量 ${line.quantity} 件 / 单价 ¥${line.unitPrice} / 金额 ¥${line.totalAmount}`,
  ]),
  `合计：${snapshot.totalQuantity} 件    合同总额：¥${snapshot.totalAmount}`,
  `预计裁片发出：${snapshot.estimatedCutPieceSendDate}    要求交货：${snapshot.deliveryDate}`,
  `加工工艺：${snapshot.processes.join("、")}`,
  "收款资料",
  `收款人：${snapshot.payeeName}    开户行：${snapshot.bankName}`,
  `银行账号：${snapshot.bankAccount}`,
  "合同条款",
  `1. 加工责任：${snapshot.terms.processingResponsibility ?? ""}`,
  `2. 质量要求：${snapshot.terms.qualityRequirements ?? ""}`,
  `3. 延期责任：${snapshot.terms.delayPenalty ?? ""}`,
  `4. 物流交接：${snapshot.terms.logistics ?? ""}`,
  `5. 合理损耗：${snapshot.terms.reasonableLoss ?? ""}`,
  `6. 次品责任：${snapshot.terms.defectRate ?? ""}`,
  `7. 付款约定：${snapshot.terms.payment ?? ""}`,
  `8. 合同效力：${snapshot.terms.validity ?? ""}`,
  "甲方签章：________________    乙方签章：________________",
].flatMap(wrapPdfLine);

const toUnicodeCMap = (lines: readonly string[]): string => {
  const codes = [...new Set(lines.join("").normalize("NFC"))]
    .map((character) => character.codePointAt(0) ?? 0x3f)
    .filter((code) => code <= 0xffff)
    .sort((left, right) => left - right);
  const mappings = codes.map((code) => {
    const value = code.toString(16).toUpperCase().padStart(4, "0");
    return `<${value}> <${value}>`;
  });
  const blocks: string[] = [];
  for (let index = 0; index < mappings.length; index += 100) {
    const block = mappings.slice(index, index + 100);
    blocks.push(`${block.length} beginbfchar\n${block.join("\n")}\nendbfchar`);
  }
  return [
    "/CIDInit /ProcSet findresource begin",
    "12 dict begin",
    "begincmap",
    "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def",
    "/CMapName /DXReworkUnicode def",
    "/CMapType 2 def",
    "1 begincodespacerange",
    "<0000> <FFFF>",
    "endcodespacerange",
    ...blocks,
    "endcmap",
    "CMapName currentdict /CMap defineresource pop",
    "end",
    "end",
  ].join("\n");
};

const streamObject = (content: string): string =>
  `<< /Length ${Buffer.byteLength(content, "binary")} >>\nstream\n${content}\nendstream`;

const renderLegacyContractPdf = (snapshot: ContractPdfSnapshot): Buffer => {
  const lines = contractTextLines(snapshot);
  const chunks: string[][] = [];
  for (let index = 0; index < lines.length; index += 34) chunks.push(lines.slice(index, index + 34));

  const objects: string[] = [];
  const add = (value: string): number => {
    objects.push(value);
    return objects.length;
  };
  const catalogId = add("");
  const pagesId = add("");
  const fontId = add("");
  const cidFontId = add(
    "<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light "
      + "/CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> /DW 1000 >>",
  );
  const cmap = toUnicodeCMap(lines);
  const cmapId = add(streamObject(cmap));
  const pageIds: number[] = [];

  for (const [pageIndex, pageLines] of chunks.entries()) {
    const content = pageLines.map((line, index) => {
      const fontSize = pageIndex === 0 && index === 0 ? 18 : 10.5;
      const y = 800 - index * 22;
      return `BT /F1 ${fontSize} Tf 1 0 0 1 44 ${y} Tm <${utf16Hex(line)}> Tj ET`;
    }).join("\n");
    const contentId = add(streamObject(content));
    const pageId = add(
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 595 842] `
        + `/Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`,
    );
    pageIds.push(pageId);
  }

  objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;
  objects[fontId - 1] = `<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [${cidFontId} 0 R] /ToUnicode ${cmapId} 0 R >>`;

  let output = "%PDF-1.7\n%\xE2\xE3\xCF\xD3\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(output, "binary"));
    output += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(output, "binary");
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  output += offsets.slice(1).map((offset) => `${offset.toString().padStart(10, "0")} 00000 n \n`).join("");
  output += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(output, "binary");
};

export const sourcingContractFingerprint = (snapshot: ContractPdfSnapshot): string =>
  createHash("sha256").update(JSON.stringify({...snapshot,lines:snapshot.lines.map(line=>{
    const {imageBytes,...facts}=line;
    return imageBytes ? {...facts,imageSha256:line.imageSha256 ?? createHash("sha256").update(imageBytes).digest("hex")} : facts;
  })})).digest("hex");

type StructuredContractLayout = "v2" | "v3";

const renderStructuredContractPdf = async (
  snapshot: ContractPdfSnapshot,
  layout: StructuredContractLayout,
): Promise<Buffer> => {
  const polished = layout === "v3";
  const document = new PDFDocument({
    size: "A4", margin: 32, bufferPages: true,
    info: { Title: snapshot.contractTitle ?? "服装加工合同", CreationDate: Number.isNaN(Date.parse(`${snapshot.contractDate}T00:00:00Z`)) ? new Date(0) : new Date(`${snapshot.contractDate}T00:00:00Z`),
      ModDate: new Date(`${snapshot.contractDate}T00:00:00Z`) },
  });
  const chunks: Buffer[] = [];
  const completed = new Promise<Buffer>((resolve, reject) => {
    document.on("data", (chunk: Buffer) => chunks.push(chunk));
    document.on("end", () => resolve(Buffer.concat(chunks)));
    document.on("error", reject);
  });

  document.font(new URL("../assets/contract-chinese.ttf", import.meta.url).pathname);
  const width = document.page.width - 64;
  const bottom = document.page.height - 40;
  let y = 32;
  const ensureSpace = (height: number): void => {
    if (y + height <= bottom) return;
    document.addPage();
    y = 32;
  };
  const text = (
    value: string,
    size = 9,
    color = "#111111",
    options: { x?: number; width?: number; align?: "left" | "center" | "right"; lineGap?: number; characterSpacing?: number; after?: number } = {},
  ): void => {
    const x = options.x ?? 32;
    const textWidth = options.width ?? width;
    const lineGap = options.lineGap ?? 2;
    document.fontSize(size).fillColor(color);
    const height = document.heightOfString(value, { width: textWidth, lineGap, align: options.align });
    ensureSpace(height + (options.after ?? 5));
    document.text(value, x, y, {
      width: textWidth,
      lineGap,
      align: options.align,
      characterSpacing: options.characterSpacing,
    });
    y = document.y + (options.after ?? 5);
  };

  if (polished) {
    text(snapshot.contractTitle ?? "服装加工合同", 18, "#111111", { align: "center", characterSpacing: 5, after: 9 });
    text(
      `合同编号：${snapshot.contractNumber}    生成日期：${snapshot.contractDate}    签订地点：${snapshot.signingPlace}`,
      9,
      "#111111",
      { align: "center", after: 13 },
    );
    text(`甲方：${snapshot.partyAName}`, 9.5, "#111111", { x: 38, width: width - 12, after: 7 });
    text(`乙方：${snapshot.partyBName}`, 9.5, "#111111", { x: 38, width: width - 12, after: 13 });
    text("一、加工明细", 10, "#111111", { after: 7 });
  } else {
    text(snapshot.contractTitle ?? "服装加工合同", 17);
    text(`合同编号：${snapshot.contractNumber}    生成日期：${snapshot.contractDate}    签订地点：${snapshot.signingPlace}`);
    text(`甲方：${snapshot.partyAName}`);
    text(`乙方：${snapshot.partyBName}`);
    text("一、加工明细", 10);
  }

  const withPictures = (snapshot.templateVersion ?? 1) >= 3;
  const widths = withPictures ? [84,80,58,36,48,61,82,width-449] : [86, 82, 85, 42, 54, 58, width - 407];
  const row = (cells: readonly string[], header = false, picture?: Buffer): void => {
    document.fontSize(8);
    const textHeights = cells.map((cell, index) =>
      document.heightOfString(cell, { width: widths[index]! - 8, lineGap: 2 }));
    const height = Math.max(picture ? 78 : 32, ...textHeights.map((item) => item + 12));
    if (y + height > bottom) { document.addPage(); y = 32; tableHeader(); }
    let x = 32;
    cells.forEach((cell, index) => {
      document.lineWidth(0.5).strokeColor("#333333");
      if (header) document.rect(x, y, widths[index]!, height).fillAndStroke("#eeeeee", "#333333");
      else document.rect(x, y, widths[index]!, height).stroke();
      if (withPictures && index === 1 && picture && !header) {
        document.image(picture,x+5,y+5,{fit:[widths[index]!-10,height-10],align:"center",valign:"center"});
      }
      const align = polished && (header || index >= 2) ? "center" : "left";
      const textHeight = document.heightOfString(cell, { width: widths[index]! - 8, lineGap: 2, align });
      const textY = polished ? y + Math.max(5, (height - textHeight) / 2) : y + 6;
      document.fillColor("#111111").text(cell, x + 4, textY, {
        width: widths[index]! - 8,
        lineGap: 2,
        align,
      });
      x += widths[index]!;
    });
    y += height;
  };
  const tableHeader = (): void => row(withPictures
    ? ["款号 / 代用款号","款式图片","颜色 / 性别款式","数量","单价\n（不含税）","金额","发裁片时间\n（工厂发出）","货期\n（到工厂）"]
    : ["款号 / 代用款号", "颜色 / 性别款式", "发裁片时间\n（工厂发出）", "数量", "单价\n（不含税）", "金额", "货期\n（到工厂）"], true);
  tableHeader();
  for (const line of snapshot.lines) {
    const identity=`${line.styleNo}${line.alternateStyleNo && line.alternateStyleNo !== line.styleNo ? ` / ${line.alternateStyleNo}` : ""}`;
    const classification=`${line.color ?? "历史未维护"}\n${snapshot.gender ?? "历史未维护"}${snapshot.styleName ?? "历史未维护"}`;
    row(withPictures ? [identity,line.imageBytes ? "" : "未提供",classification,formatBusinessDecimal(line.quantity),
      formatSourcingContractPrice(line.unitPrice),formatBusinessDecimal(line.totalAmount),snapshot.estimatedCutPieceSendDate,snapshot.deliveryDate]
      : [identity,classification,snapshot.estimatedCutPieceSendDate,formatBusinessDecimal(line.quantity),formatSourcingContractPrice(line.unitPrice),formatBusinessDecimal(line.totalAmount),snapshot.deliveryDate],false,line.imageBytes);
  }
  y += polished ? 7 : 5;
  text(`合计：${formatBusinessDecimal(snapshot.totalQuantity)} 件    金额：${formatBusinessDecimal(snapshot.totalAmount)} 元`, 9, "#111111", { after: polished ? 11 : 5 });

  // Keep the responsibility clause intact; only the dynamic responsibility segment is red.
  document.fontSize(9);
  const [responsibilityPrefix,responsibilitySuffix] = (snapshot.terms.processingResponsibility && (snapshot.templateVersion ?? 1)>=4
    ? snapshot.terms.processingResponsibility : "乙方负责{{工艺}}，甲方提供样板及面/辅料。").split("{{工艺}}");
  const customResponsibility = (snapshot.templateVersion ?? 1)>=4 && !snapshot.terms.processingResponsibility?.includes("{{工艺}}");
  const responsibility = customResponsibility ? `二、${snapshot.terms.processingResponsibility ?? ""}`
    : `二、${responsibilityPrefix}${snapshot.processes.join("、")}${responsibilitySuffix}`;
  const responsibilityHeight = document.heightOfString(responsibility, { width, lineGap: 2 });
  if (y + responsibilityHeight > bottom && responsibilityHeight < bottom - 32) { document.addPage(); y = 32; }
  if (customResponsibility) document.fillColor("#111111").text(responsibility,32,y,{width,lineGap:2});
  else {
    document.fillColor("#111111").text(`二、${responsibilityPrefix}`, 32, y, { width, lineGap: 2, continued: true });
    document.fillColor("#c00000").text(snapshot.processes.join("、"), { continued: true });
    document.fillColor("#111111").text(responsibilitySuffix ?? "");
  }
  y = document.y + (polished ? 10 : 6);

  const clauses = [
    ["三、质量要求", "qualityRequirements"], ["四、交货时间", "delayPenalty"],
    ["五、交货地点及运输方式", "logistics"], ["六、物料合理损耗及计算方法", "reasonableLoss"],
    ["七、次品率", "defectRate"], ["八、付款方式", "payment"],
    ["九、生效与补充协议", "effectiveness"], ["十、有效期", "validity"],
  ] as const;
  for (const [title, key] of clauses) {
    const clause = snapshot.terms[key] ?? "";
    if (polished && key === "qualityRequirements") {
      text(`${title}：`, 9, "#111111", { after: 3 });
      text(clause, 9, "#111111", { x: 44, width: width - 12, lineGap: 3, after: 8 });
    } else {
      text(`${title}：${clause}`, 9, "#111111", { after: polished ? 7 : 5 });
    }
  }

  if (polished) {
    const gap = 34;
    const columnWidth = (width - gap) / 2;
    const leftX = 32;
    const rightX = leftX + columnWidth + gap;
    const left = [
      `甲方（盖章）：${snapshot.partyAName}`,
      `地址：${snapshot.partyAAddress ?? "历史未维护"}`,
      `甲方代表：${snapshot.partyARepresentative || "________________"}`,
      `签署日期：${snapshot.partyASigningDate || "____年____月____日"}`,
    ];
    const right = [
      `乙方（盖章）：${snapshot.partyBName}`,
      `地址：${snapshot.partyBAddress}`,
      `乙方代表：${snapshot.partyBRepresentative}`,
      `收款人：${snapshot.payeeName}`,
      `开户行：${snapshot.bankName}`,
      `银行账号：${snapshot.bankAccount}`,
      `签署日期：${snapshot.partyBSigningDate || "____年____月____日"}`,
    ];
    const columnHeight = (lines: readonly string[]): number => lines.reduce((sum, line) => (
      sum + document.heightOfString(line, { width: columnWidth, lineGap: 2 }) + 5
    ), 0);
    const signatureHeight = Math.max(columnHeight(left), columnHeight(right));
    ensureSpace(signatureHeight + 8);
    const signatureY = y;
    const drawColumn = (x: number, lines: readonly string[]): void => {
      let currentY = signatureY;
      document.fontSize(9).fillColor("#111111");
      for (const line of lines) {
        document.text(line, x, currentY, { width: columnWidth, lineGap: 2 });
        currentY = document.y + 5;
      }
    };
    drawColumn(leftX, left);
    drawColumn(rightX, right);
    y = signatureY + signatureHeight + 5;
  } else {
    if (y + 130 > bottom) { document.addPage(); y = 32; }
    text(`甲方（盖章）：${snapshot.partyAName}`);
    text(`地址：${snapshot.partyAAddress ?? "历史未维护"}`);
    text(`甲方代表：${snapshot.partyARepresentative || "________________"}    签署日期：${snapshot.partyASigningDate || "____年____月____日"}`);
    text(`乙方（盖章）：${snapshot.partyBName}`);
    text(`地址：${snapshot.partyBAddress}    乙方代表：${snapshot.partyBRepresentative}`);
    text(`收款人：${snapshot.payeeName}    开户行：${snapshot.bankName}`);
    text(`银行账号：${snapshot.bankAccount}    签署日期：${snapshot.partyBSigningDate || "____年____月____日"}`);
  }

  const pages = document.bufferedPageRange();
  for (let index = 0; index < pages.count; index += 1) {
    document.switchToPage(index);
    document.page.margins.bottom = 0;
    document.fontSize(7).fillColor("#555555").text(
      `${snapshot.contractNumber}    ${index + 1} / ${pages.count}`,
      32,
      document.page.height - 26,
      { width, lineBreak: false, align: polished ? "center" : "left" },
    );
  }
  document.end();
  return completed;
};

// Generated attachments remain immutable. The current V2 template now uses the
// approved presentation refinements for newly generated documents only.
export const renderSourcingContractPdf = async (snapshot: ContractPdfSnapshot): Promise<Buffer> => {
  if ((snapshot.templateVersion ?? 1) >= 2) {
    return renderStructuredContractPdf(snapshot, "v3");
  }
  return renderLegacyContractPdf(snapshot);
};
