export type WorkbookNumberFormat = "business" | "precise";
export type WorkbookNumberCell = Readonly<{
  value: string | number;
  numberFormat?: WorkbookNumberFormat;
}>;
export type WorkbookCell = string | number | boolean | null | WorkbookNumberCell;
export type WorkbookSheet = Readonly<{ name: string; rows: readonly (readonly WorkbookCell[])[] }>;

export const workbookNumberCell = (
  value: string | number,
  numberFormat: WorkbookNumberFormat = "business",
): WorkbookNumberCell => ({ value, numberFormat });

const numericCellXml = (ref: string, value: string | number, style: number): string => {
  const text = String(value).trim();
  if (!/^-?\d+(?:\.\d+)?$/.test(text) || !Number.isFinite(Number(text))) {
    throw new Error("Workbook numeric cell requires a finite plain decimal");
  }
  return `<c r="${ref}" s="${style}" t="n"><v>${text}</v></c>`;
};

const escapeXml = (value: string): string => value
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&apos;");

const column = (index: number): string => {
  let value = index + 1;
  let output = "";
  while (value > 0) {
    value -= 1;
    output = String.fromCharCode(65 + value % 26) + output;
    value = Math.floor(value / 26);
  }
  return output;
};

const worksheet = (rows: readonly (readonly WorkbookCell[])[]): string => {
  const data = rows.map((row, rowIndex) => {
    const cells = row.map((value, columnIndex) => {
      const ref = `${column(columnIndex)}${rowIndex + 1}`;
      if (typeof value === "number" && Number.isFinite(value)) {
        return numericCellXml(ref, value, 1);
      }
      if (value !== null && typeof value === "object") {
        return numericCellXml(ref, value.value, value.numberFormat === "precise" ? 2 : 1);
      }
      const text = value === null ? "" : typeof value === "boolean" ? (value ? "true" : "false") : String(value);
      return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(text)}</t></is></c>`;
    }).join("");
    return `<row r="${rowIndex + 1}">${cells}</row>`;
  }).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="2" topLeftCell="A3" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetData>${data}</sheetData></worksheet>`;
};

const crcTable = Array.from({ length: 256 }, (_, input) => {
  let value = input;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
const crc32 = (buffer: Buffer): number => {
  let value = 0xffffffff;
  for (const byte of buffer) value = crcTable[(value ^ byte) & 0xff]! ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
};
const u16 = (value: number): Buffer => { const buffer = Buffer.alloc(2); buffer.writeUInt16LE(value); return buffer; };
const u32 = (value: number): Buffer => { const buffer = Buffer.alloc(4); buffer.writeUInt32LE(value >>> 0); return buffer; };
const zip = (files: ReadonlyArray<{ name: string; content: string }>): Buffer => {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, "utf8");
    const content = Buffer.from(file.content, "utf8");
    const checksum = crc32(content);
    const local = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(0), u16(0),
      u32(checksum), u32(content.length), u32(content.length), u16(name.length), u16(0), name, content,
    ]);
    locals.push(local);
    centrals.push(Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(0), u16(0),
      u32(checksum), u32(content.length), u32(content.length), u16(name.length),
      u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), name,
    ]));
    offset += local.length;
  }
  const central = Buffer.concat(centrals);
  return Buffer.concat([
    ...locals, central,
    u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length),
    u32(central.length), u32(offset), u16(0),
  ]);
};

const safeSheetName = (name: string, used: Set<string>): string => {
  const base = name.replace(/[\\/*?:[\]]/g, " ").trim().slice(0, 31) || "Sheet";
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) {
    const marker = `-${suffix}`;
    candidate = `${base.slice(0, 31 - marker.length)}${marker}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
};

export function buildWorkbook(sheets: readonly WorkbookSheet[]): Buffer {
  if (sheets.length === 0 || sheets.length > 20) throw new Error("Workbook requires between 1 and 20 sheets");
  const used = new Set<string>();
  const names = sheets.map((sheet) => safeSheetName(sheet.name, used));
  const overrides = sheets.map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("");
  const workbookSheets = names.map((name, index) => `<sheet name="${escapeXml(name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join("");
  const relationships = sheets.map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join("");
  return zip([
    { name: "[Content_Types].xml", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${overrides}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>` },
    { name: "_rels/.rels", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: "xl/workbook.xml", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${workbookSheets}</sheets></workbook>` },
    { name: "xl/_rels/workbook.xml.rels", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationships}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    { name: "xl/styles.xml", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="2"><numFmt numFmtId="164" formatCode="#,##0.##"/><numFmt numFmtId="165" formatCode="#,##0.########"/></numFmts><fonts count="1"><font><sz val="11"/><name val="Noto Sans SC"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="3"><xf xfId="0"/><xf xfId="0" numFmtId="164" applyNumberFormat="1"/><xf xfId="0" numFmtId="165" applyNumberFormat="1"/></cellXfs></styleSheet>` },
    ...sheets.map((sheet, index) => ({ name: `xl/worksheets/sheet${index + 1}.xml`, content: worksheet(sheet.rows) })),
  ]);
}
