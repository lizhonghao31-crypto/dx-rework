import type { AdminAuditEvent, AdminAuditEventsPage, AdminAuditEventsQuery, AdminAuditExport, AdminAuditExportsPage, AdminAuditExportsQuery } from "@dx-rework/contracts";
import type { Pool } from "pg";

import { ApplicationError } from "./platform/errors.js";

type Row = Readonly<{
  event_id: string;
  request_id: string;
  actor_id: string;
  actor_display_name: string | null;
  actor_roles: string[];
  authorization_capability: string;
  action: string;
  entity_type: string;
  entity_id: string;
  before_state: unknown | null;
  after_state: unknown | null;
  reason: string | null;
  created_at: Date;
  export_type?: string | null;
  report_type?: string | null;
  total_count: string;
}>;

type Cursor = Readonly<{ createdAt: string; eventId: string }>;

const encodeCursor = (row: Row): string => Buffer.from(JSON.stringify({ createdAt: row.created_at.toISOString(), eventId: row.event_id }), "utf8").toString("base64url");
const decodeCursor = (value: string | undefined): Cursor | null => {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (typeof parsed?.createdAt !== "string" || typeof parsed?.eventId !== "string") throw new Error("bad cursor");
    if (Number.isNaN(Date.parse(parsed.createdAt)) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(parsed.eventId)) throw new Error("bad cursor");
    return { createdAt: parsed.createdAt, eventId: parsed.eventId };
  } catch {
    throw new ApplicationError("VALIDATION_ERROR", "Invalid audit cursor", 400);
  }
};

const eventDto = (row: Row): AdminAuditEvent => ({
  eventId: row.event_id,
  requestId: row.request_id,
  actorId: row.actor_id,
  actorDisplayName: row.actor_display_name,
  actorRoles: row.actor_roles,
  authorizationCapability: row.authorization_capability,
  action: row.action,
  entityType: row.entity_type,
  entityId: row.entity_id,
  beforeState: row.before_state,
  afterState: row.after_state,
  reason: row.reason,
  createdAt: row.created_at.toISOString(),
});

export class AdminAuditService {
  constructor(private readonly db: Pool) {}

  async events(query: AdminAuditEventsQuery): Promise<AdminAuditEventsPage> {
    const params: unknown[] = [];
    const where = this.commonWhere(query, params, null);
    if (query.action) where.push(`event.action=$${params.push(query.action)}`);
    if (query.entityType) where.push(`event.entity_type=$${params.push(query.entityType)}`);
    if (query.entityId) where.push(`event.entity_id=$${params.push(query.entityId)}`);
    if (query.authorizationCapability) where.push(`event.authorization_capability=$${params.push(query.authorizationCapability)}`);
    if (query.requestId) where.push(`event.request_id=$${params.push(query.requestId)}`);
    const rows = await this.select(where, params, query.limit, (query.page - 1) * query.limit);
    const pageRows = rows.slice(0, query.limit);
    const totalCount = Number(pageRows[0]?.total_count ?? "0");
    return {
      items: pageRows.map(eventDto),
      page: query.page,
      pageSize: query.limit,
      totalCount,
      totalPages: Math.max(1, Math.ceil(totalCount / query.limit)),
    };
  }

  async exports(query: AdminAuditExportsQuery): Promise<AdminAuditExportsPage> {
    const cursor = decodeCursor(query.cursor);
    const params: unknown[] = [];
    const where = this.commonWhere(query, params, cursor);
    where.push(`(event.action LIKE '%export%' OR event.entity_type='export_job')`);
    if (query.exportType) where.push(`COALESCE(event.after_state->>'exportType',event.after_state->>'reportType')=$${params.push(query.exportType)}`);
    if (query.reportType) where.push(`event.after_state->>'reportType'=$${params.push(query.reportType)}`);
    const rows = await this.select(where, params, query.limit);
    return this.page(rows, query.limit, (row): AdminAuditExport => ({ ...eventDto(row), exportType: row.export_type ?? null, reportType: row.report_type ?? null }));
  }

  private commonWhere(query: { from?: string | undefined; to?: string | undefined; actorId?: string | undefined }, params: unknown[], cursor: Cursor | null): string[] {
    const where: string[] = [];
    if (query.from) where.push(`event.created_at >= $${params.push(query.from)}`);
    if (query.to) where.push(`event.created_at <= $${params.push(query.to)}`);
    if (query.actorId) where.push(`event.actor_id=$${params.push(query.actorId)}`);
    if (cursor) where.push(`(event.created_at,event.event_id) < ($${params.push(cursor.createdAt)}::timestamptz,$${params.push(cursor.eventId)}::uuid)`);
    return where;
  }

  private async select(where: string[], params: unknown[], limit: number, offset = 0): Promise<Row[]> {
    const sql = `SELECT event.event_id,event.request_id,event.actor_id,"user".display_name actor_display_name,event.actor_roles,event.authorization_capability,event.action,event.entity_type,event.entity_id,event.before_state,event.after_state,event.reason,event.created_at,event.after_state->>'exportType' export_type,event.after_state->>'reportType' report_type,count(*) OVER()::text total_count FROM operation_events event LEFT JOIN app_users "user" ON "user".id=event.actor_id ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY event.created_at DESC,event.event_id DESC LIMIT $${params.push(limit + 1)} OFFSET $${params.push(offset)}`;
    return (await this.db.query<Row>(sql, params)).rows;
  }

  private page<T>(rows: Row[], limit: number, map: (row: Row) => T): { items: T[]; nextCursor: string | null } {
    const pageRows = rows.slice(0, limit);
    return { items: pageRows.map(map), nextCursor: rows.length > limit ? encodeCursor(pageRows.at(-1)!) : null };
  }
}
