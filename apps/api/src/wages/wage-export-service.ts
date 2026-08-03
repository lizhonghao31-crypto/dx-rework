import type { Pool } from "pg";

import { ApplicationError } from "../platform/errors.js";
import type { TrustedActorContext } from "../tools/repositories.js";

type Cell = string | number | null;
type PeriodRow = {
  period_month: string;
  status: string;
  final_total: string;
  locked_by: string | null;
  locked_at: Date | null;
};
type ExportLine = {
  period_month: string; person_id: string; person_name: string;
  person_type: string; rework_no: string; style_no: string;
  process_name: string; quantity: string; unit: string; unit_price: string;
  assignment_mode: string; member_count: number; member_snapshot: unknown;
  group_amount: string; exact_share: string; original_amount: string;
  adjustment_amount: string; final_amount: string;
};

const fail = (message: string, status = 409, code = "CONFLICT"): never => {
  throw new ApplicationError(code, message, status);
};
const first = <T>(rows: T[], message: string): T => {
  const value = rows[0];
  if (value === undefined) {
    throw new ApplicationError("NOT_FOUND", message, 404);
  }
  return value;
};
const escapeXml = (value: string): string => value
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;").replaceAll('"', "&quot;")
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
const worksheet = (rows: Cell[][]): string => {
  const data = rows.map((row, rowIndex) => {
    const cells = row.map((value, columnIndex) => {
      const ref = `${column(columnIndex)}${rowIndex + 1}`;
      if (typeof value === "number") return `<c r="${ref}" t="n"><v>${value}</v></c>`;
      return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(value === null ? "" : value)}</t></is></c>`;
    }).join("");
    return `<row r="${rowIndex + 1}">${cells}</row>`;
  }).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="2" topLeftCell="A3" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetData>${data}</sheetData></worksheet>`;
};
const crcTable = Array.from({ length: 256 }, (_, input) => {
  let value = input;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});
const crc32 = (buffer: Buffer): number => {
  let value = 0xffffffff;
  for (const byte of buffer) value = crcTable[(value ^ byte) & 0xff]! ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
};
const u16 = (value: number): Buffer => {
  const buffer = Buffer.alloc(2); buffer.writeUInt16LE(value); return buffer;
};
const u32 = (value: number): Buffer => {
  const buffer = Buffer.alloc(4); buffer.writeUInt32LE(value >>> 0); return buffer;
};
const zip = (files: ReadonlyArray<{ name: string; content: string }>): Buffer => {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, "utf8");
    const content = Buffer.from(file.content, "utf8");
    const checksum = crc32(content);
    const local = Buffer.concat([
      u32(0x04034b50),u16(20),u16(0x0800),u16(0),u16(0),u16(0),
      u32(checksum),u32(content.length),u32(content.length),u16(name.length),u16(0),
      name,content,
    ]);
    locals.push(local);
    centrals.push(Buffer.concat([
      u32(0x02014b50),u16(20),u16(20),u16(0x0800),u16(0),u16(0),u16(0),
      u32(checksum),u32(content.length),u32(content.length),u16(name.length),
      u16(0),u16(0),u16(0),u16(0),u32(0),u32(offset),name,
    ]));
    offset += local.length;
  }
  const central = Buffer.concat(centrals);
  return Buffer.concat([
    ...locals,central,
    u32(0x06054b50),u16(0),u16(0),u16(files.length),u16(files.length),
    u32(central.length),u32(offset),u16(0),
  ]);
};

export function buildWageWorkbook(detailRows: Cell[][], summaryRows: Cell[][]): Buffer {
  return zip([
    { name: "[Content_Types].xml", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>` },
    { name: "_rels/.rels", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: "xl/workbook.xml", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="工资明细" sheetId="1" r:id="rId1"/><sheet name="人员汇总" sheetId="2" r:id="rId2"/></sheets></workbook>` },
    { name: "xl/_rels/workbook.xml.rels", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    { name: "xl/styles.xml", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Noto Sans SC"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="1"><xf xfId="0"/></cellXfs></styleSheet>` },
    { name: "xl/worksheets/sheet1.xml", content: worksheet(detailRows) },
    { name: "xl/worksheets/sheet2.xml", content: worksheet(summaryRows) },
  ]);
}

const cents = (value: string): bigint => {
  if (!/^-?\d+\.\d{2}$/.test(value)) fail("工资导出金额格式异常", 500, "INTERNAL_ERROR");
  const negative = value.startsWith("-");
  const parts = (negative ? value.slice(1) : value).split(".");
  const result = BigInt(parts[0] ?? "0") * 100n + BigInt(parts[1] ?? "0");
  return negative ? -result : result;
};
const money = (value: bigint): string => {
  const absolute = value < 0n ? -value : value;
  return `${value < 0n ? "-" : ""}${absolute / 100n}.${(absolute % 100n).toString().padStart(2, "0")}`;
};

export class WageExportService {
  constructor(private readonly db: Pool) {}

  async export(actor: TrustedActorContext, periodId: string): Promise<{ filename: string; content: Buffer }> {
    if (!actor.authorizationCapabilities?.includes("wage:export")) fail("缺少工资导出能力", 403, "FORBIDDEN");
    await this.db.query("SELECT access_authorized_actor_roles($1,'wage:export')", [actor.actorId]);
    const periodResult = await this.db.query<PeriodRow>(
      `SELECT period_month::text,status,final_total::text,locked_by,locked_at
       FROM rework_wage_periods WHERE period_id=$1`, [periodId],
    );
    const period = first(periodResult.rows, "工资期间不存在");
    const lines = period.status === "locked"
      ? await this.db.query<ExportLine>(
        `SELECT period.period_month::text,lines.person_id,
          lines.person_name_snapshot person_name,lines.person_type_snapshot person_type,
          lines.rework_no_snapshot rework_no,lines.style_no_snapshot style_no,
          lines.process_name_snapshot process_name,lines.quantity_snapshot::text quantity,
          lines.unit_snapshot unit,lines.unit_price_snapshot::text unit_price,
          lines.assignment_mode,jsonb_array_length(lines.member_snapshot) member_count,
          lines.member_snapshot,COALESCE(item.group_amount,0)::text group_amount,
          COALESCE(item.exact_person_share,0)::text exact_share,
          lines.original_amount::text,lines.adjustment_amount::text,lines.final_amount::text
         FROM rework_wage_month_closures closure
         JOIN rework_wage_periods period ON period.period_id=closure.period_id
         JOIN rework_wage_month_close_lines lines ON lines.closure_id=closure.closure_id
         LEFT JOIN rework_wage_items item ON item.wage_item_id=COALESCE(
           lines.wage_item_id,(SELECT original_wage_item_id FROM rework_wage_adjustments
             WHERE adjustment_id=lines.adjustment_id))
         WHERE closure.period_id=$1
         ORDER BY lines.person_name_snapshot,lines.closure_line_id`, [periodId],
      )
      : await this.db.query<ExportLine>(
        `WITH approved AS (
           SELECT original_wage_item_id,sum(adjustment_amount) amount
           FROM rework_wage_adjustments WHERE target_period_id=$1 AND status='approved'
           GROUP BY original_wage_item_id)
         SELECT period.period_month::text,item.person_id,
          item.person_name_snapshot person_name,item.person_type_snapshot person_type,
          item.rework_no_snapshot rework_no,item.style_no_snapshot style_no,
          item.process_name_snapshot process_name,item.actual_quantity_snapshot::text quantity,
          item.pricing_unit_snapshot unit,item.unit_price_snapshot::text unit_price,
          item.assignment_mode,item.member_count,item.member_snapshot,
          item.group_amount::text group_amount,item.exact_person_share::text exact_share,
          item.payable_amount::text original_amount,COALESCE(approved.amount,0)::text adjustment_amount,
          (item.payable_amount+COALESCE(approved.amount,0))::text final_amount
         FROM rework_wage_items item JOIN rework_wage_periods period ON period.period_id=item.period_id
         LEFT JOIN approved ON approved.original_wage_item_id=item.wage_item_id
         WHERE item.period_id=$1 ORDER BY item.person_name_snapshot,item.created_at,item.wage_item_id`, [periodId],
      );
    const tail = period.status === "pending_tail_review" ? "待李同生初核" : "已完成";
    const admin = ["pending_tail_review", "pending_admin_review"].includes(period.status)
      ? "待梁少萍复核" : "已完成";
    const detailRows: Cell[][] = [
      [period.status === "locked" ? "正式月结文件" : "未锁定预览"],
      ["工资月份","工人稳定ID","工人姓名快照","正式工/临时工","返工单号","款号","工序","数量/工时","单位","单价","个人/集体","集体成员人数","成员快照","组总额","高精度个人份额","正式个人金额","调整金额","最终金额","尾部初核","行政复核","月结状态","锁定人","锁定时间"],
      ...lines.rows.map((line) => [
        line.period_month.slice(0, 7),line.person_id,line.person_name,line.person_type,
        line.rework_no,line.style_no,line.process_name,line.quantity,line.unit,
        line.unit_price,line.assignment_mode,line.member_count,JSON.stringify(line.member_snapshot),
        line.group_amount,line.exact_share,line.original_amount,line.adjustment_amount,
        line.final_amount,tail,admin,period.status,period.locked_by,
        period.locked_at?.toISOString() ?? "",
      ]),
    ];
    const summaries = new Map<string, { name: string; type: string; original: bigint; adjustment: bigint; final: bigint }>();
    let total = 0n;
    for (const line of lines.rows) {
      const entry = summaries.get(line.person_id) ?? { name: line.person_name, type: line.person_type, original: 0n, adjustment: 0n, final: 0n };
      entry.original += cents(line.original_amount);
      entry.adjustment += cents(line.adjustment_amount);
      entry.final += cents(line.final_amount);
      total += cents(line.final_amount);
      summaries.set(line.person_id, entry);
    }
    if (money(total) !== period.final_total) fail("工资导出明细合计与期间总额不一致");
    const summaryRows: Cell[][] = [
      ["工资月份","工人稳定ID","工人姓名快照","人员类型","原始金额","调整金额","最终金额"],
      ...[...summaries.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name)).map(([id, value]) => [period.period_month.slice(0, 7),id,value.name,value.type,money(value.original),money(value.adjustment),money(value.final)]),
      ["合计","","","",money([...summaries.values()].reduce((sum, value) => sum + value.original, 0n)),money([...summaries.values()].reduce((sum, value) => sum + value.adjustment, 0n)),money(total)],
    ];
    const month = period.period_month.slice(0, 7);
    return {
      filename: period.status === "locked" ? `返工工资月结-${month}.xlsx` : `未锁定预览-返工工资-${month}.xlsx`,
      content: buildWageWorkbook(detailRows, summaryRows),
    };
  }
}
