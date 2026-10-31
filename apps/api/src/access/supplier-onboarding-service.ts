import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { SupplierOnboardingProfileSchema, SupplierOnboardingResubmitSchema, SupplierOnboardingReturnSchema, SupplierOnboardingVersionSchema,
  type SupplierOnboardingDetail, type SupplierOnboardingProfile, type SupplierOnboardingSummary } from "@dx-rework/contracts/supplier-onboarding";
import type { z } from "zod";
import { ApplicationError } from "../platform/errors.js";
import { IdempotencyService, OperationEventRepository, type TrustedActorContext } from "../tools/repositories.js";
import { TodoService } from "../todos/service.js";
import { TodoProjectionService } from "../todos/projection-service.js";
import { AccessMasterDataService } from "./service.js";

type Row = { request_id: string; applicant_id: string; applicant_name: string; status: SupplierOnboardingSummary["status"];
  current_version: number; supplier_id: string | null; created_at: Date; updated_at: Date; profile: SupplierOnboardingProfile };
const selection = `SELECT r.*,v.profile FROM supplier_onboarding_requests r JOIN supplier_onboarding_request_versions v
 ON (v.request_id,v.version)=(r.request_id,r.current_version)`;
const summary = (r: Row): SupplierOnboardingSummary => ({ requestId: r.request_id, applicantId: r.applicant_id, applicantName: r.applicant_name,
  supplierName: r.profile.supplierName, supplierType: r.profile.supplierType, status: r.status, version: r.current_version,
  supplierId: r.supplier_id, createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString() });
const readRole = (actor: TrustedActorContext) => reviewRole(actor) || actor.actorRoles.includes("pmc");
const readMode = (actor: TrustedActorContext) => actor.authorizationCapability === "supplier_onboarding:read" ? "read" : reviewRole(actor) ? "approve" : "request";
const reviewRole = (actor: TrustedActorContext) => actor.actorRoles.some(role => ["root_superuser", "owner_group", "production_management"].includes(role));
const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const result = schema.safeParse(value);
  if (!result.success) throw new ApplicationError("VALIDATION_ERROR", result.error.issues[0]?.message ?? "请检查必填资料", 400);
  return result.data;
};
const translate = (error: unknown): never => {
  const code = (error as { code?: string }).code;
  if (code === "23505") throw new ApplicationError("CONFLICT", "同名称、同类型的供应商或待审批申请已存在，请先核对已有资料", 409);
  if (code === "42501") throw new ApplicationError("FORBIDDEN", "当前账号没有此申请操作权限", 403);
  if (code === "55000") throw new ApplicationError("CONFLICT", "申请状态或版本已变化，请刷新后重试", 409);
  if (code === "23514") throw new ApplicationError("VALIDATION_ERROR", "请补齐供应商必填资料", 400);
  throw error;
};
export class SupplierOnboardingService {
  private readonly todos: TodoService;
  private readonly projection: TodoProjectionService;
  private readonly suppliers: AccessMasterDataService;
  private readonly events = new OperationEventRepository();
  private readonly idempotency = new IdempotencyService();
  constructor(private readonly db: Pool, todos?: TodoService) {
    this.todos = todos ?? new TodoService(db);
    this.projection = new TodoProjectionService(this.todos);
    this.suppliers = new AccessMasterDataService(db, "");
  }
  private async authorize(client: Pick<PoolClient, "query">, actor: TrustedActorContext, mode: "request" | "approve" | "read") {
    try {
      const result = await client.query<{ roles: string[] }>("SELECT supplier_onboarding_authorized_roles($1,$2) roles", [actor.actorId, mode]);
      return { ...actor, actorRoles: result.rows[0]!.roles, authorizationCapability: `supplier_onboarding:${mode}` };
    } catch (error) { return translate(error); }
  }
  async list(actor: TrustedActorContext, scope: "mine" | "pending" | "all") {
    const effective = await this.authorize(this.db, actor, readMode(actor));
    const reviewer = readRole(effective);
    if (scope !== "mine" && !reviewer) throw new ApplicationError("FORBIDDEN", "只能查看本人的申请", 403);
    const result = await this.db.query<Row>(`${selection} WHERE ($1<>'mine' OR r.applicant_id=$2)
      AND ($1<>'pending' OR r.status='pending_approval') ORDER BY r.updated_at DESC,r.request_id`, [scope, actor.actorId]);
    return result.rows.map(summary);
  }
  async get(actor: TrustedActorContext, id: string): Promise<SupplierOnboardingDetail> {
    const effective = await this.authorize(this.db, actor, readMode(actor));
    const row = (await this.db.query<Row>(`${selection} WHERE r.request_id=$1 AND ($2 OR r.applicant_id=$3)`, [id, readRole(effective), actor.actorId])).rows[0];
    if (!row) throw new ApplicationError("NOT_FOUND", "申请不存在或不属于当前账号", 404);
    const versions = (await this.db.query<{ version: number; profile: SupplierOnboardingProfile; submitted_at: Date }>("SELECT version,profile,submitted_at FROM supplier_onboarding_request_versions WHERE request_id=$1 ORDER BY version", [id])).rows;
    const decisions = (await this.db.query<{ version: number; decision: "approved" | "returned"; reason: string | null; reviewer_name: string; decided_at: Date }>("SELECT version,decision,reason,reviewer_name,decided_at FROM supplier_onboarding_decisions WHERE request_id=$1 ORDER BY version", [id])).rows;
    const check = readRole(effective) && row.status === "pending_approval"
      ? (await this.db.query<{ formal_count: number; pending_count: number; checked_at: Date }>(`SELECT CURRENT_TIMESTAMP checked_at,
        (SELECT count(*)::int FROM current_supplier_catalog c WHERE c.supplier_type=$2
          AND normalize_supplier_name(c.supplier_name)=normalize_supplier_name($1)) formal_count,
        (SELECT count(*)::int FROM supplier_onboarding_requests r JOIN supplier_onboarding_request_versions v
          ON (v.request_id,v.version)=(r.request_id,r.current_version) WHERE r.status='pending_approval' AND r.request_id<>$3
          AND v.profile->>'supplierType'=$2 AND normalize_supplier_name(v.profile->>'supplierName')=normalize_supplier_name($1)) pending_count`,
      [row.profile.supplierName, row.profile.supplierType, id])).rows[0] : undefined;
    return { ...summary(row), profile: row.profile,
      ...(check ? { duplicateCheck: { formalSupplierCount: check.formal_count, pendingRequestCount: check.pending_count, checkedAt: check.checked_at.toISOString() } } : {}),
      versions: versions.map(v => ({ version: v.version, profile: v.profile, submittedAt: v.submitted_at.toISOString() })),
      decisions: decisions.map(d => ({ version: d.version, decision: d.decision, reason: d.reason, reviewerName: d.reviewer_name, decidedAt: d.decided_at.toISOString() })) };
  }
  private async mutate(actor: TrustedActorContext, mode: "request" | "approve", action: string, key: string, input: unknown,
    work: (client: PoolClient, effective: TrustedActorContext) => Promise<{ requestId: string; version: number; supplierId?: string }>) {
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(key)) throw new ApplicationError("VALIDATION_ERROR", "缺少有效操作标识，请重试", 400);
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      const effective = await this.authorize(client, actor, mode);
      const outcome = await this.idempotency.execute(client, { scope: `supplier-onboarding:${action}`, actorKey: actor.actorId, key,
        requestHash: createHash("sha256").update(JSON.stringify(input)).digest("hex"), expiresAt: new Date("9999-12-31T00:00:00Z") },
      async () => ({ statusCode: 200, response: await work(client, effective) }));
      await client.query("COMMIT");
      return outcome;
    } catch (error) { await client.query("ROLLBACK"); return translate(error); }
    finally { client.release(); }
  }
  private async target(client: PoolClient, actor: TrustedActorContext, id: string, version: number, status: Row["status"], own = false) {
    const row = (await client.query<Row>(`${selection} WHERE r.request_id=$1 AND (NOT $2 OR r.applicant_id=$3) FOR UPDATE OF r`, [id, own, actor.actorId])).rows[0];
    if (!row) throw new ApplicationError("NOT_FOUND", "申请不存在或不属于当前账号", 404);
    if (row.current_version !== version || row.status !== status) throw new ApplicationError("CONFLICT", "申请状态或版本已变化，请刷新后重试", 409);
    return row;
  }
  private async applicantName(client: PoolClient, id: string) {
    return (await client.query<{ display_name: string }>("SELECT display_name FROM app_users WHERE id=$1", [id])).rows[0]!.display_name;
  }
  private async approvalTodos(client: PoolClient, actor: TrustedActorContext, id: string, version: number, eventId: string, sourceAction: string) {
    const recipients = (await client.query<{ user_id: string; role_code: string }>(`SELECT DISTINCT ON (a.user_id) a.user_id,a.role_code
      FROM user_role_assignments a WHERE a.revoked_at IS NULL AND a.role_code IN ('owner_group','production_management')
      AND todo_user_has_direct_role(a.user_id,a.role_code,'supplier_onboarding:approve') ORDER BY a.user_id,a.role_code`)).rows;
    for (const recipient of recipients) await this.projection.actionableForNamedRecipient(client, actor, {
      category: "supplier_onboarding_approval", sourceEventId: eventId, sourceAction, entityType: "supplier_onboarding", entityId: id,
      recipientUserId: recipient.user_id, requiredRole: recipient.role_code, requiredCapability: "supplier_onboarding:approve",
      route: { routeName: "supplier_onboarding", entityId: id }, policyKey: "general", dedupeKey: `supplier-onboarding:${id}:${version}:approval:${recipient.user_id}`,
    });
  }
  async submit(actor: TrustedActorContext, raw: unknown, key: string) {
    const profile = parse(SupplierOnboardingProfileSchema, raw);
    return this.mutate(actor, "request", "submit", key, profile, async (client, effective) => {
      const id = randomUUID();
      await client.query("INSERT INTO supplier_onboarding_requests(request_id,applicant_id,applicant_name,status,current_version) VALUES($1,$2,$3,'pending_approval',1)", [id, actor.actorId, await this.applicantName(client, actor.actorId)]);
      await client.query("INSERT INTO supplier_onboarding_request_versions(request_id,version,profile,submitted_by) VALUES($1,1,$2,$3)", [id, profile, actor.actorId]);
      const action = "supplier_onboarding.submitted";
      const event = await this.events.append(client, effective, { action, entityType: "supplier_onboarding", entityId: id, after: { version: 1, status: "pending_approval", supplierName: profile.supplierName } });
      await this.approvalTodos(client, effective, id, 1, event, action);
      return { requestId: id, version: 1 };
    });
  }
  async resubmit(actor: TrustedActorContext, id: string, raw: unknown, key: string) {
    const input = parse(SupplierOnboardingResubmitSchema, raw);
    return this.mutate(actor, "request", "resubmit", key, { id, ...input }, async (client, effective) => {
      await this.target(client, effective, id, input.version, "returned", true);
      const version = input.version + 1;
      await client.query("INSERT INTO supplier_onboarding_request_versions(request_id,version,profile,submitted_by) VALUES($1,$2,$3,$4)", [id, version, input.profile, actor.actorId]);
      await client.query("UPDATE supplier_onboarding_requests SET current_version=$2,status='pending_approval',updated_at=CURRENT_TIMESTAMP WHERE request_id=$1", [id, version]);
      const action = "supplier_onboarding.resubmitted";
      const event = await this.events.append(client, effective, { action, entityType: "supplier_onboarding", entityId: id, before: { version: input.version, status: "returned" }, after: { version, status: "pending_approval", supplierName: input.profile.supplierName } });
      await this.todos.completeOpenByDedupePrefix(client, effective, `supplier-onboarding:${id}:`, "申请已修改重提");
      await this.approvalTodos(client, effective, id, version, event, action);
      return { requestId: id, version };
    });
  }
  async decide(actor: TrustedActorContext, id: string, decision: "approved" | "returned", raw: unknown, key: string) {
    const input = decision === "returned" ? parse(SupplierOnboardingReturnSchema, raw) : parse(SupplierOnboardingVersionSchema, raw);
    const reason = "reason" in input && typeof input.reason === "string" ? input.reason : undefined;
    return this.mutate(actor, "approve", decision, key, { id, ...input }, async (client, effective) => {
      const row = await this.target(client, effective, id, input.version, "pending_approval");
      let supplierId: string | undefined;
      if (decision === "approved") {
        await client.query("SELECT assert_supplier_onboarding_identity($1,$2)", [row.profile, id]);
        const result = await this.suppliers.createSupplierWithClient(client, { ...effective, authorizationCapability: "supplier_profile:write" }, {
          ...row.profile, supplierCode: `SUP_${randomUUID().replaceAll("-", "").slice(0, 20).toUpperCase()}`, changeReason: "新增供应商申请审批通过",
        });
        supplierId = result.supplierId;
      }
      await client.query("INSERT INTO supplier_onboarding_decisions(decision_id,request_id,version,decision,reason,reviewer_id,reviewer_name,supplier_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)", [randomUUID(), id, input.version, decision, reason ?? null, actor.actorId, await this.applicantName(client, actor.actorId), supplierId ?? null]);
      await client.query("UPDATE supplier_onboarding_requests SET status=$2,supplier_id=$3,updated_at=CURRENT_TIMESTAMP WHERE request_id=$1", [id, decision, supplierId ?? null]);
      const action = `supplier_onboarding.${decision}`;
      const event = await this.events.append(client, effective, { action, entityType: "supplier_onboarding", entityId: id,
        before: { version: input.version, status: "pending_approval" }, after: { version: input.version, status: decision, supplierId: supplierId ?? null }, ...(reason ? { reason } : {}) });
      await this.todos.completeOpenByDedupePrefix(client, effective, `supplier-onboarding:${id}:`, decision === "approved" ? "申请已审批通过" : "申请已退回");
      if (decision === "returned") {
        const roles = (await client.query<{ role_code: string }>(`SELECT role_code FROM user_role_assignments WHERE user_id=$1 AND revoked_at IS NULL
          AND role_code IN ('order_merchandiser','embroidery_washing_merchandiser') ORDER BY role_code LIMIT 1`, [row.applicant_id])).rows;
        await this.projection.actionableForNamedRecipient(client, effective, {
          category: "supplier_onboarding_return", sourceEventId: event, sourceAction: action, entityType: "supplier_onboarding", entityId: id,
          recipientUserId: row.applicant_id, requiredRole: roles[0]?.role_code ?? "order_merchandiser", requiredCapability: "supplier_onboarding:request",
          route: { routeName: "supplier_onboarding", entityId: id }, policyKey: "general", dedupeKey: `supplier-onboarding:${id}:${input.version}:return`,
        });
      }
      return { requestId: id, version: input.version, ...(supplierId ? { supplierId } : {}) };
    });
  }
}
