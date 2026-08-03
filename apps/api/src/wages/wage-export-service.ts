import type { Pool } from "pg";

import { ApplicationError } from "../platform/errors.js";
import type { TrustedActorContext } from "../tools/repositories.js";

type WorkbookValue = string | number | null;
type ExportLine = {
  period_month: string;
  person_id: string;
  person_name: string;
  person_type: string;
  rework_no: string;
  style_no: string;
  process_name: string;
  quantity: string;
  unit: string;
  unit_price: string;
  assignment_mode: string;
  member_count: number;
  member_snapshot: unknown;
  group_amount: string;
  exact_share: string;
  original_amount: string;
  adjustment_amount: string;
  final_amount: string;
};
type PeriodRow = {
  period_month: string;
  status: string;
  final_total: string;
  locked_by: string | null;
  locked_at: Date | null;
};

const fail = (message: string, status = 409, code = "CONFLICT"): never => {
  throw new ApplicationError(code, message, status);
};

const xml = (value: string): string => value
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&apos;");

const columnName = (index: number): string => {
  let value = index + 1;
  let output = "";
  while (value > 0) {
    value -= 1;
    output = String.fromCharCode(65 + (value % 26)) + output;
    value = Math.floor(value / 26);
  }
  return output;
};

const worksheet = (rows: WorkbookValue[][]): string => {
  const body = rows.map((row, rowIndex) => {
    const cells = row.map((value, columnIndex) => {
      const reference = `${columnName(columnIndex)}${rowIndex + 1}`;
      if (typeof value === "number") {
        return `<c r="${reference}" t="n"><v>${value}</v></c>`;
      }
      const text = value === null ? "" : String(value);
      return `<c r="${reference}" t="inlineStr"><is><t xml:space="preserve">${xml(text)}</t></is></c>`;
    }).join("");
    return `<row r="${rowIndex + 1}">${cells}</row>`;
  }).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetData>${body}</sheetData></worksheet>`;
};

const crcTable = Array.from({ length: 256 }, (_, value) => {
  let current = value;
  for (let bit = 0; bit < 8; bit += 1) {
    current = (current & 1) !== 0
      ? 0xedb88320 ^ (current >>> 1)
      : current >>> 1;
  }
  return current >>> 0;
});

const crc32 = (value: Buffer): number => {
  let crc = 0xffffffff;
  for (const byte of value) {
    crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
};

const u16 = (value: number): Buffer => {
  const output = Buffer.alloc(2);
  output.writeUInt16LE(value);
  return output;
};
const u32 = (value: number): Buffer => {
  const output = Buffer.alloc(4);
  output.writeUInt32LE(value >>> 0);
  return output;
};

const zip = (files: ReadonlyArray<{ name: string; content: string }>): Buffer => {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, "utf8");
    const content = Buffer.from(file.content, "utf8");
    const checksum = crc32(content);
    const local = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(0), u16(0),
      u32(checksum), u32(content.length), u32(content.length),
      u16(name.length), u16(0), name, content,
    ]);
    localParts.push(local);
    centralParts.push(Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(0),
      u16(0), u32(checksum), u32(content.length), u32(content.length),
      u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0),
      u32(offset), name,
    ]));
    offset += local.length;
  }
  const central = Buffer.concat(centralParts);
  const end = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length),
    u32(central.length), u32(offset), u16(0),
  ]);
  return Buffer.concat([...localParts, central, end]);
};

export function buildWageWorkbook(
  detailRows: WorkbookValue[][],
  summaryRows: WorkbookValue[][],
): Buffer {
  return zip([
    {
      name: "[Content_Types].xml",
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    },
    {
      name: "_rels/.rels",
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    },
    {
      name: "xl/workbook.xml",
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="工资明细" sheetId="1" r:id="rId1"/><sheet name="人员汇总" sheetId="2" r:id="rId2"/></sheets></workbook>`,
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    },
    {
      name: "xl/styles.xml",
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Noto Sans SC"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="1"><xf xfId="0"/></cellXfs></styleSheet>`,
    },
    { name: "xl/worksheets/sheet1.xml", content: worksheet(detailRows) },
    { name: "xl/worksheets/sheet2.xml", content: worksheet(summaryRows) },
  ]);
}

const signedCents = (value: string): bigint => {
  const match = value.match(/^(-?)(\d+)\.(\d{2})$/);
  if (!match) fail("工资导出金额格式异常", 500, "INTERNAL_ERROR");
  const result = BigInt(match[2]!) * 100n + BigInt(match[3]!);
  return match[1] === "-" ? -result : result;
};
const formatCents = (value: bigint): string => {
  const absolute = value < 0n ? -value : value;
  return `${value < 0n ? "-" : ""}${absolute / 100n}.${(absolute % 100n)
    .toString().padStart(2, "0")}`;
};

export class WageExportService {
  constructor(private readonly database: Pool) {}

  async export(
    actor: TrustedActorContext,
    periodId: string,
  ): Promise<{ filename: string; content: Buffer }> {
    if (!actor.authorizationCapabilities?.includes("wage:export")) {
      fail("缺少工资导出能力", 403, "FORBIDDEN");
    }
    await this.database.query(
      "SELECT access_authorized_actor_roles($1,'wage:export')",
      [actor.actorId],
    );
    const periodResult = await this.database.query<PeriodRow>(
      `SELECT period_month::text,status,final_total::text,locked_by,locked_at
       FROM rework_wage_periods WHERE period_id=$1`,
      [periodId],
    );
    const period = periodResult.rows[0];
    if (!period) fail("工资期间不存在", 404, "NOT_FOUND");

    const lineResult = period.status === "locked"
      ? await this.database.query<ExportLine>(
          `SELECT period.period_month::text,lines.person_id,
                  lines.person_name_snapshot person_name,
                  lines.person_type_snapshot person_type,
                  lines.rework_no_snapshot rework_no,
                  lines.style_no_snapshot style_no,
                  lines.process_name_snapshot process_name,
                  lines.quantity_snapshot::text quantity,
                  lines.unit_snapshot unit,lines.unit_price_snapshot::text unit_price,
                  lines.assignment_mode,
                  jsonb_array_length(lines.member_snapshot) member_count,
                  lines.member_snapshot,
                  COALESCE(item.group_amount,0)::text group_amount,
                  COALESCE(item.exact_person_share,0)::text exact_share,
                  lines.original_amount::text,lines.adjustment_amount::text,
                  lines.final_amount::text
           FROM rework_wage_month_closures closure
           JOIN rework_wage_periods period ON period.period_id=closure.period_id
           JOIN rework_wage_month_close_lines lines
             ON lines.closure_id=closure.closure_id
           LEFT JOIN rework_wage_items item
             ON item.wage_item_id=COALESCE(
               lines.wage_item_id,
               (SELECT original_wage_item_id FROM rework_wage_adjustments
                WHERE adjustment_id=lines.adjustment_id)
             )
           WHERE closure.period_id=$1
           ORDER BY lines.person_name_snapshot,lines.closure_line_id`,
          [periodId],
        )
      : await this.database.query<ExportLine>(
          `WITH approved AS (
             SELECT original_wage_item_id,sum(adjustment_amount) amount
             FROM rework_wage_adjustments
             WHERE target_period_id=$1 AND status='approved'
             GROUP BY original_wage_item_id
           )
           SELECT period.period_month::text,item.person_id,
                  item.person_name_snapshot person_name,
                  item.person_type_snapshot person_type,
                  item.rework_no_snapshot rework_no,
                  item.style_no_snapshot style_no,
                  item.process_name_snapshot process_name,
                  item.actual_quantity_snapshot::text quantity,
                  item.pricing_unit_snapshot unit,item.unit_price_snapshot::text unit_price,
                  item.assignment_mode,item.member_count,item.member_snapshot,
                  item.group_amount::text group_amount,
                  item.exact_person_share::text exact_share,
                  item.payable_amount::text original_amount,
                  COALESCE(approved.amount,0)::text adjustment_amount,
                  (item.payable_amount+COALESCE(approved.amount,0))::text final_amount
           FROM rework_wage_items item
           JOIN rework_wage_periods period ON period.period_id=item.period_id
           LEFT JOIN approved ON approved.original_wage_item_id=item.wage_item_id
           WHERE item.period_id=$1
           ORDER BY item.person_name_snapshot,item.created_at,item.wage_item_id`,
          [periodId],
        );

    const tailStatus = period.status === "pending_tail_review"
      ? "待李同生初核"
      : "已完成";
    const administrativeStatus =
      period.status === "pending_tail_review" || period.status === "pending_admin_review"
        ? "待梁少萍复核"
        : "已完成";
    const detailsHeader: WorkbookValue[] = [
      "工资月份","工人稳定ID","工人姓名快照","正式工/临时工","返工单号",
      "款号","工序","数量/工时","单位","单价","个人/集体","集体成员人数",
      "成员快照","组总额","高精度个人份额","正式个人金额","调整金额",
      "最终金额","尾部初核","行政复核","月结状态","锁定人","锁定时间",
    ];
    const detailRows: WorkbookValue[][] = [
      [period.status === "locked" ? "正式月结文件" : "未锁定预览"],
      detailsHeader,
      ...lineResult.rows.map((line) => [
        line.period_month.slice(0, 7),line.person_id,line.person_name,line.person_type,
        line.rework_no,line.style_no,line.process_name,line.quantity,line.unit,
        line.unit_price,line.assignment_mode,line.member_count,
        JSON.stringify(line.member_snapshot),line.group_amount,line.exact_share,
        line.original_amount,line.adjustment_amount,line.final_amount,tailStatus,
        administrativeStatus,period.status,period.locked_by,
        period.locked_at?.toISOString() ?? "",
      ]),
    ];

    const summaries = new Map<string, {
      name: string;
      type: string;
      original: bigint;
      adjustment: bigint;
      final: bigint;
    }>();
    let detailTotal = 0n;
    for (const line of lineResult.rows) {
      const current = summaries.get(line.person_id) ?? {
        name: line.person_name,
        type: line.person_type,
        original: 0n,
        adjustment: 0n,
        final: 0n,
      };
      current.original += signedCents(line.original_amount);
      current.adjustment += signedCents(line.adjustment_amount);
      current.final += signedCents(line.final_amount);
      detailTotal += signedCents(line.final_amount);
      summaries.set(line.person_id, current);
    }
    if (formatCents(detailTotal) !== period.final_total) {
      fail("工资导出明细合计与期间总额不一致", 409, "CONFLICT");
    }
    const summaryRows: WorkbookValue[][] = [
      ["工资月份","工人稳定ID","工人姓名快照","人员类型","原始金额",
        "调整金额","最终金额"],
      ...[...summaries.entries()]
        .sort((left, right) => left[1].name.localeCompare(right[1].name))
        .map(([personId, value]) => [
          period.period_month.slice(0, 7),personId,value.name,value.type,
          formatCents(value.original),formatCents(value.adjustment),
          formatCents(value.final),
        ]),
      ["合计","","","",formatCents(
        [...summaries.values()].reduce((sum, value) => sum + value.original, 0n),
      ),formatCents(
        [...summaries.values()].reduce((sum, value) => sum + value.adjustment, 0n),
      ),formatCents(detailTotal)],
    ];
    const month = period.period_month.slice(0, 7);
    return {
      filename: period.status === "locked"
        ? `返工工资月结-${month}.xlsx`
        : `未锁定预览-返工工资-${month}.xlsx`,
      content: buildWageWorkbook(detailRows, summaryRows),
    };
  }
}
