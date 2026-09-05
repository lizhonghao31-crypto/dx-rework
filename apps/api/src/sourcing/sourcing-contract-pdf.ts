import { createHash } from "node:crypto";

export type ContractPdfLine = Readonly<{
  position: number;
  styleNo: string;
  alternateStyleNo: string | null;
  color: string | null;
  quantity: number;
  unitPrice: string;
  totalAmount: string;
}>;

export type ContractPdfSnapshot = Readonly<{
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
  "外发服装加工合同",
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

export const renderSourcingContractPdf = (snapshot: ContractPdfSnapshot): Buffer => {
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
  createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
