import {developmentRoundsAvailable} from "./development-round-repository.js";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { DevelopmentDocument } from "@dx-rework/contracts/digital-development";
import type { TrustedActorContext } from "../tools/repositories.js";
import { DigitalProductionAccessPolicy } from "./access-policy.js";

export async function projectDevelopmentNotices(db: PoolClient, people: TrustedActorContext[], now = new Date()) {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const rounds=await developmentRoundsAvailable(db);
  const documents=rounds?"digital_development_current_documents":"digital_development_documents";
  const rows = (await db.query(`SELECT d.*,s.created_by,s.design_style_no FROM ${documents} d JOIN digital_production_sources s USING(source_id)
    LEFT JOIN digital_production_resource_lifecycle l ON l.resource_kind='source' AND l.resource_id=d.source_id
    WHERE d.status='published' AND coalesce(l.state,'active')='active'`)).rows;
  const notice = async (row: typeof rows[number], key: string, title: string, designerOnly = false) => {
    const recipients = people.filter(person => person.actorId === row.created_by && person.actorRoles.includes("sample_designer") || !designerOnly && person.actorRoles.includes("pattern_room_supervisor"));
    const inserted = (await db.query(`INSERT INTO digital_production_notification_events(event_id,source_key,development_source_id,event_kind)
      VALUES($1,$2,$3,'development_information') ON CONFLICT(source_key) DO NOTHING RETURNING event_id`, [randomUUID(), key, row.source_id])).rows[0];
    if (!inserted) return;
    await db.query(`INSERT INTO digital_development_notices(event_id,source_id,title${rounds?",round_number":""}) VALUES($1,$2,$3${rounds?",$4":""})`, [inserted.event_id,row.source_id,`${row.design_style_no} · ${title}`,...(rounds?[row.round_number]:[])]);
    for (const person of recipients) if (await new DigitalProductionAccessPolicy(db).allowed(person,"source",row.source_id,"technical"))
      await db.query("INSERT INTO digital_production_notification_receipts(event_id,source_event_id,recipient_id) VALUES($1,$1,$2)",[inserted.event_id,person.actorId]);
  };
  for (const row of rows) {
    const document = row.document as DevelopmentDocument;
    if (document.craft !== "无" && document.files.some(file => file.kind === "工艺开发板")) await notice(row,`development-craft:${row.source_id}:${row.version}`,"工艺开发板已提交",true);
    const events = (await db.query("SELECT *,expected_date::text AS date FROM digital_development_material_events WHERE source_id=$1 ORDER BY sequence",[row.source_id])).rows;
    for (const material of document.materials.filter(item => item.category === "辅料" && item.requiredThisRound)) {
      const history = events.filter(event => event.material_id === material.materialId);
      for (const event of history.filter(event => event.action === "到货" || event.action === "确认代用")) await notice(row,`development-material:${event.event_id}`,`${material.label || material.name} · ${event.action}`);
      if (material.available || history.some(event => event.action === "到货" || event.action === "确认代用")) continue;
      const revision = history.filter(event => event.action === "修改预计日期").at(-1);
      const date = revision?.date ?? material.expectedDate;
      if (!date) continue;
      const days = Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000);
      const stage = days < 0 ? "已逾期" : days === 0 ? "今日预计到货" : days === 1 ? "明日预计到货" : null;
      // Only the current stage is emitted: importing an overdue item never replays yesterday/today.
      if (stage) await notice(row,`development-due:${row.source_id}:${material.materialId}:${revision?.event_id ?? row.version}:${stage}`,`${material.label || material.name} · ${stage}（${date}）`);
    }
  }
}
