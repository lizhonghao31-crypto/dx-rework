import type { Pool, PoolClient } from "pg";
import { validateBusinessTime } from "@dx-rework/domain/business-clock";
import { acceptanceBusinessContext, ContextBusinessClock } from "../acceptance-clock/business-time.js";
import { ApplicationError } from "../platform/errors.js";
import type { OperationEventRepository, TrustedActorContext } from "../tools/repositories.js";

type Database = Pick<PoolClient, "query">;
const conflict = (): never => { throw new ApplicationError("ACCEPTANCE_ISOLATION", "合同业务就绪缺少匹配的已验证本单时钟", 409); };
const iso = (value: Date | string): string => new Date(value).toISOString();

async function availability(db: Database) {
  return (await db.query(`SELECT to_regclass('digital_production_child_links') AS links,
    to_regclass('acceptance_sla_clock_resources') AS resources,
    to_regclass('sourcing_contract_business_ready_facts') AS facts`)).rows[0];
}
async function caseScope(db: Database, caseId: string, available: Awaited<ReturnType<typeof availability>>) {
  const links = available.links ? (await db.query("SELECT production_order_id FROM digital_production_child_links WHERE module='sourcing' AND child_id=$1", [caseId])).rows : [];
  if (links.length > 1) conflict();
  const orderId = links[0]?.production_order_id as string | undefined;
  const scene = orderId && available.resources
    ? (await db.query("SELECT scenario_id FROM acceptance_sla_clock_resources WHERE resource_kind='order' AND resource_id=$1", [orderId])).rows[0]?.scenario_id as string | undefined
    : undefined;
  return { orderId: orderId ?? null, scenarioId: scene ?? null };
}

/** New first-ready identity is captured under the case lock; legacy identity retains its original audit ordering. */
export async function firstContractBusinessReady(db: Database, orderId: string) {
  const available = await availability(db);
  if (!available.links) return { at: null, evidence: "contract-not-ready", kind: "unknown" as const };
  const document = (await db.query(`SELECT d.sourcing_contract_document_id,d.sourcing_case_id,d.generated_at
    FROM digital_production_child_links l JOIN sourcing_contract_documents d ON d.sourcing_case_id=l.child_id
    ${available.facts ? "LEFT JOIN sourcing_contract_business_ready_facts f ON f.sourcing_contract_document_id=d.sourcing_contract_document_id" : ""}
    WHERE l.production_order_id=$1 AND l.module='sourcing' AND d.generated_at IS NOT NULL
    ORDER BY ${available.facts ? "CASE WHEN f.is_first_for_case THEN 0 ELSE 1 END," : ""}d.generated_at,d.contract_version,d.sourcing_contract_document_id LIMIT 1`, [orderId])).rows[0];
  if (!document) return { at: null, evidence: "contract-not-ready", kind: "unknown" as const };
  const scope = await caseScope(db, document.sourcing_case_id, available);
  const fact = available.facts ? (await db.query("SELECT * FROM sourcing_contract_business_ready_facts WHERE sourcing_contract_document_id=$1", [document.sourcing_contract_document_id])).rows[0] : undefined;
  if (fact) {
    const time = validateBusinessTime(fact.business_time);
    if (time.scenarioId !== scope.scenarioId || Date.parse(time.now) !== new Date(fact.business_ready_at).getTime()) conflict();
    return { at: iso(fact.business_ready_at), evidence: `contract-business-ready:${fact.operation_event_id}`, kind: "business" as const };
  }
  if (scope.scenarioId) return { at: null, evidence: `contract-business-ready:unknown:${document.sourcing_contract_document_id}`, kind: "unknown" as const };
  return { at: iso(document.generated_at), evidence: `legacy-contract-pdf:${document.sourcing_contract_document_id}`, kind: "legacy" as const };
}

/** Called only after this transaction first changes a never-generated document to ready. */
export async function recordContractBusinessReady(
  db: PoolClient, pool: Pool, actor: TrustedActorContext, events: Pick<OperationEventRepository, "append">,
  caseId: string, documentId: string,
) {
  const available = await availability(db), scope = await caseScope(db, caseId, available);
  // Only contracts linked to a native production order participate in its
  // factory readiness dependency. Standalone sourcing contracts keep their
  // original PDF/return-monitoring lifecycle and historical identity.
  if (!scope.orderId) {
    if (acceptanceBusinessContext()) conflict();
    return { created: false, first: false, orderId: null };
  }
  if (!available.facts) {
    if (scope.scenarioId || acceptanceBusinessContext()) conflict();
    return { created: false, first: false, orderId: scope.orderId };
  }
  if ((await db.query("SELECT 1 FROM sourcing_contract_business_ready_facts WHERE sourcing_contract_document_id=$1", [documentId])).rowCount)
    return { created: false, first: false, orderId: scope.orderId };
  const time = validateBusinessTime(await new ContextBusinessClock(pool).read({ kind: "order", id: scope.orderId }));
  if (time.scenarioId !== scope.scenarioId) conflict();
  const document = (await db.query("SELECT pdf_attachment_id,pdf_sha256 FROM sourcing_contract_documents WHERE sourcing_contract_document_id=$1 AND sourcing_case_id=$2 AND status='ready'", [documentId, caseId])).rows[0];
  if (!document) throw new ApplicationError("INVALID_STATE_TRANSITION", "合同尚未成功就绪", 409);
  const first = !(await db.query("SELECT 1 FROM sourcing_contract_documents WHERE sourcing_case_id=$1 AND sourcing_contract_document_id<>$2 AND generated_at IS NOT NULL LIMIT 1", [caseId, documentId])).rowCount;
  const eventId = await events.append(db, actor, {
    action: "sourcing.contract.business_ready", entityType: "sourcing_contract_document", entityId: documentId,
    after: { sourcingCaseId: caseId, pdfAttachmentId: document.pdf_attachment_id, pdfSha256: document.pdf_sha256, businessReadyAt: time.now, businessTime: time, firstForCase: first },
  });
  await db.query(`INSERT INTO sourcing_contract_business_ready_facts(sourcing_contract_document_id,sourcing_case_id,
    pdf_attachment_id,pdf_sha256,business_ready_at,business_time,operation_event_id,is_first_for_case) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
  [documentId, caseId, document.pdf_attachment_id, document.pdf_sha256, time.now, JSON.stringify(time), eventId, first]);
  return { created: true, first, orderId: scope.orderId };
}
