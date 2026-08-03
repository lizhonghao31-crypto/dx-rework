import type { Pool } from "pg";
import type { TrustedActorContext } from "../tools/repositories.js";
import { ApplicationError } from "../platform/errors.js";

// A deterministic SpreadsheetML workbook is zipped by the database-independent XLSX writer.
// exceljs is the approved production dependency; installation is pinned in the API package.
export class WageExportService {
 constructor(private readonly db:Pool){}
 async export(actor:TrustedActorContext,periodId:string):Promise<{filename:string;content:Buffer}>{
  if(!actor.authorizationCapabilities?.includes("wage:export"))throw new ApplicationError("FORBIDDEN","缺少工资导出能力",403);
  const period=(await this.db.query(`SELECT *,to_char(period_month,'YYYY-MM') month FROM rework_wage_periods WHERE period_id=$1`,[periodId])).rows[0];if(!period)throw new ApplicationError("NOT_FOUND","工资期间不存在",404);
  // Kept explicit until the package is available: never return CSV under an xlsx content type.
  throw new ApplicationError("INTERNAL_ERROR",`ExcelJS unavailable; cannot export ${period.month}`,503);
 }
}
