import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Pool } from "pg";
import { OperationEventRepository, type TrustedActorContext } from "../tools/repositories.js";
import { isRootActor } from "../access/business-authority.js";
import { ApplicationError } from "../platform/errors.js";

const LegacyEntitySchema = z.object({ id: z.string().trim().min(1).max(200) }).passthrough();
const LegacyStoreSchema = z.object({
  samples: z.array(LegacyEntitySchema), logs: z.array(LegacyEntitySchema),
  borrowRequests: z.array(LegacyEntitySchema), updatedAt: z.string().min(1),
});
export type SampleSourceSnapshot = z.infer<typeof LegacyStoreSchema>;
export type MigrationIssue = { entityType: string; legacyId: string; code: string; field?: string };
export type SampleInventory = {
  sourceHash: string; sourceUpdatedAt: string; sampleCount: number; logCount: number; requestCount: number;
  states: Record<string, number>; purchaseTotal: string; amountComplete: boolean;
  borrowHistoryCount: number; disposalHistoryCount: number;
  attachments: { objectKey: string; purposes: string[]; sampleIds: string[];
    references: { entityType: string; legacyId: string; field: string }[] }[];
  issues: MigrationIssue[];
  // Inventory is not an import approval. Object checks, identity mapping and reconciliation come next.
  readyForImport: false;
};

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(
    Object.entries(value).sort(([a], [b]) => a.localeCompare(b, "en")).map(([key, item]) => [key, canonical(item)]),
  );
  return value;
}
export function sampleSourceHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
export function parseSampleSource(input: unknown): SampleSourceSnapshot {
  const envelope = z.object({ success: z.literal(true), source: z.literal("ecs-native-json"), db: z.unknown() }).safeParse(input);
  // Explicit known store collections; never carry legacy role passwords/settings or QR sessions.
  const source = LegacyStoreSchema.parse(envelope.success ? envelope.data.db : input);
  for (const [kind, entries] of [["sample", source.samples], ["log", source.logs], ["borrow_request", source.borrowRequests]] as const) {
    const ids = new Set<string>();
    for (const entry of entries) {
      if (ids.has(entry.id)) throw new Error(`Duplicate legacy ${kind} ID`);
      ids.add(entry.id);
    }
  }
  return source;
}

export function sampleMoneyCents(input: unknown): bigint {
  // Legacy JSON numbers are accepted only through their exact decimal spelling; never multiply floats.
  const value = typeof input === "number" && Number.isFinite(input) ? String(input) : input;
  if (typeof value !== "string" || !/^(0|[1-9]\d{0,11})(\.\d{1,2})?$/.test(value)) {
    throw new Error("Invalid sample money: non-negative, at most two decimal places required");
  }
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, "0"));
}
export function sampleMoneyText(cents: bigint): string {
  if (cents < 0n) throw new Error("Negative sample amount");
  return `${cents / 100n}.${String(cents % 100n).padStart(2, "0")}`;
}

function objectKeyFrom(reference: unknown): string | null {
  if (typeof reference !== "string" || !reference.trim()) return null;
  const text = reference.trim();
  if (text.startsWith("https://")) {
    const url = new URL(text);
    if (url.hostname !== "daxing-sample-media.oss-cn-hangzhou.aliyuncs.com" || url.username || url.password || url.port) return null;
    const key = decodeURIComponent(url.pathname.slice(1));
    return safeObjectKey(key);
  }
  return safeObjectKey(text);
}
function safeObjectKey(key: string): string | null {
  return key.startsWith("daxing-sample/") && !key.includes(":") && !/[\\?#]/.test(key)
    && ![...key].some((character) => character.charCodeAt(0)<32)
    && !key.split("/").some((segment) => segment === ".." || segment === "." || !segment) ? key : null;
}
function attachmentKey(input: unknown): string | null {
  try {
    if (typeof input === "string") return objectKeyFrom(input);
    if (!input || typeof input !== "object") return null;
    const ref = input as Record<string, unknown>;
    return objectKeyFrom(ref.objectKey) ?? objectKeyFrom(ref.url) ?? objectKeyFrom(ref.previewUrl);
  } catch { return null; }
}

export function inventorySampleSource(input: unknown): { source: SampleSourceSnapshot; report: SampleInventory } {
  const source = parseSampleSource(input);
  const issues: MigrationIssue[] = [];
  const states: Record<string, number> = Object.create(null) as Record<string, number>;
  const codes = new Set<string>();
  const attachments = new Map<string, { objectKey: string; purposes: Set<string>; sampleIds: Set<string>;
    references: { entityType: string; legacyId: string; field: string }[] }>();
  const collect = (value: unknown, entityType: string, legacyId: string, sampleId: string | undefined,
    path: string, candidate = false): void => {
    const purpose = /receipt/i.test(path) ? "purchase_receipt" : /payment|compensation/i.test(path) ? "payment_proof"
      : /disposal|sale|gift|scrap|loss/i.test(path) ? "disposal_proof" : /return/i.test(path) ? "return_photo"
        : /image|photo/i.test(path) ? "sample_image" : "legacy_evidence";
    const record = (reference: unknown) => {
      const key = attachmentKey(reference);
      if (!key) { issues.push({ entityType, legacyId, code: "INVALID_ATTACHMENT_REFERENCE", field: path }); return; }
      const entry = attachments.get(key) ?? { objectKey: key, purposes: new Set<string>(), sampleIds: new Set<string>(), references: [] };
      entry.purposes.add(purpose);
      if (sampleId) entry.sampleIds.add(sampleId);
      entry.references.push({ entityType, legacyId, field: path });
      attachments.set(key, entry);
    };
    if (typeof value === "string") {
      if (value && (candidate || value.startsWith("daxing-sample/") || value.includes("daxing-sample-media.oss-cn-hangzhou.aliyuncs.com"))) record(value);
    } else if (Array.isArray(value)) value.forEach((entry, index) => collect(entry, entityType, legacyId, sampleId, `${path}[${index}]`, candidate));
    else if (value && typeof value === "object") {
      const object = value as Record<string, unknown>;
      const referenceKeys = ["objectKey", "url", "previewUrl"];
      const reference = referenceKeys.some(key => typeof object[key] === "string" && object[key] !== "");
      if (reference) record(value);
      for (const [key, entry] of Object.entries(object)) {
        if (reference && referenceKeys.includes(key)) continue;
        collect(entry, entityType, legacyId, sampleId, path ? `${path}.${key}` : key,
          /^(?:.*(?:images?|photos?|receipts?|proofs?|attachments?|screenshots?))$/i.test(key));
      }
    }
  };
  for (const [kind, entries] of [["sample", source.samples], ["log", source.logs], ["borrow_request", source.borrowRequests]] as const) {
    for (const entry of entries) collect(entry, kind, entry.id, kind === "sample" ? entry.id : typeof entry.sampleId === "string" ? entry.sampleId : undefined, "");
  }
  let cents = 0n;
  let amountComplete = true;
  let borrowHistoryCount = 0;
  let disposalHistoryCount = 0;
  const knownStates = new Set(["BORROWED", "IN_STOCK", "PENDING_BORROW", "PENDING_RETURN", "PENDING_DISPOSAL", "DISPOSED", "SOLD", "GIFTED", "SCRAPPED", "LOST"]);
  for (const sample of source.samples) {
    const issue = (code: string, field?: string) => issues.push({ entityType: "sample", legacyId: sample.id, code, ...(field ? { field } : {}) });
    const state = typeof sample.status === "string" ? sample.status : "MISSING";
    states[state] = (states[state] ?? 0) + 1;
    if (!knownStates.has(state)) issue("UNKNOWN_STATE", "status");
    if (state === "DISPOSED") issue("DISPOSED_REQUIRES_EXPLICIT_TYPE", "status");
    if (typeof sample.sampleCode !== "string" || !sample.sampleCode.trim()) issue("MISSING_CODE", "sampleCode");
    else if (codes.has(sample.sampleCode)) issue("DUPLICATE_CODE", "sampleCode");
    else codes.add(sample.sampleCode);
    try { cents += sampleMoneyCents(sample.purchasePrice); }
    catch { issue("INVALID_AMOUNT", "purchasePrice"); amountComplete = false; }
    for (const field of ["brand", "styleName", "color", "department", "purchaseDate", "purchaser"]) {
      if (typeof sample[field] !== "string" || !sample[field].trim()) issue("MISSING_FIELD", field);
    }
    // Labels are evidence, never identity. Resolutions must be explicit stable platform IDs.
    issue("IDENTITY_MAPPING_REQUIRED", "purchaser");
    if (state === "BORROWED" && !sample.currentHolder) issue("MISSING_HOLDER", "currentHolder");
    if (sample.currentHolder) issue("IDENTITY_MAPPING_REQUIRED", "currentHolder");
    for (const [field, count] of [["borrowHistory", "borrow"], ["disposalHistory", "disposal"]]) {
      const history = sample[field!];
      if (!Array.isArray(history)) issue("INVALID_HISTORY", field);
      else if (count === "borrow") borrowHistoryCount += history.length;
      else disposalHistoryCount += history.length;
    }
    let receiptCount = 0;
    for (const [purpose, refs] of [
      ["purchase_receipt", [sample.receiptImage, ...(Array.isArray(sample.receiptImages) ? sample.receiptImages : [])]],
      ["sample_image", [...(Array.isArray(sample.images) ? sample.images : []), ...(Array.isArray(sample.sampleImages) ? sample.sampleImages : [])]],
    ] as const) {
      for (const reference of refs.filter((value) => value !== null && value !== undefined && value !== "")) {
        const key = attachmentKey(reference);
        if (!key) continue;
        if (purpose === "purchase_receipt") receiptCount++;
      }
    }
    if (!receiptCount) issue("MISSING_RECEIPT", "receiptImages");
    if (sample.pendingTask || sample.disposalRequest) issue("IN_FLIGHT_REBUILD_REQUIRED");
  }
  const sampleIds = new Set(source.samples.map((sample) => sample.id));
  for (const log of source.logs) {
    if (typeof log.sampleId === "string" && !sampleIds.has(log.sampleId)) issues.push({ entityType: "log", legacyId: log.id, code: "ORPHAN_HISTORY" });
  }
  return { source, report: {
    sourceHash: sampleSourceHash(source), sourceUpdatedAt: source.updatedAt,
    sampleCount: source.samples.length, logCount: source.logs.length, requestCount: source.borrowRequests.length,
    states, purchaseTotal: sampleMoneyText(cents), amountComplete, borrowHistoryCount, disposalHistoryCount,
    attachments: [...attachments.values()].map((entry) => ({ objectKey: entry.objectKey, purposes: [...entry.purposes].sort(), sampleIds: [...entry.sampleIds].sort(), references: entry.references })),
    issues, readyForImport: false,
  } };
}

// Stage immutable source evidence only. No sample_items, financial facts or live todos are written.
export async function stageSampleSource(database: Pool, actor: TrustedActorContext, input: unknown): Promise<{ batchId: string; reused: boolean }> {
  if (!isRootActor(actor)) throw new ApplicationError("FORBIDDEN", "只有 root 可暂存样衣迁移源", 403);
  const { source, report } = inventorySampleSource(input);
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`sample-migration:${report.sourceHash}`]);
    const prior = await client.query<{ batch_id: string }>("SELECT batch_id FROM sample_migration_batches WHERE source_system='daxing-sample-assistant' AND source_hash=$1", [report.sourceHash]);
    if (prior.rows[0]) { await client.query("COMMIT"); return { batchId: prior.rows[0].batch_id, reused: true }; }
    const batchId = randomUUID();
    await client.query(`INSERT INTO sample_migration_batches(batch_id,source_system,source_hash,source_updated_at,sample_count,log_count,report,created_by)
      VALUES($1,'daxing-sample-assistant',$2,$3,$4,$5,$6,$7)`,
    [batchId, report.sourceHash, source.updatedAt, source.samples.length, source.logs.length, report, actor.actorId]);
    for (const [kind, entries] of [["sample", source.samples], ["log", source.logs], ["borrow_request", source.borrowRequests]] as const) {
      for (const row of entries) await client.query(`INSERT INTO sample_legacy_mappings(batch_id,entity_type,legacy_id,source_hash,source_payload)
        VALUES($1,$2,$3,$4,$5)`, [batchId, kind, row.id, sampleSourceHash(row), row]);
    }
    await new OperationEventRepository().append(client, actor, { action: "sample.migration_staged", entityType: "sample_migration_batch", entityId: batchId,
      after: { sourceHash: report.sourceHash, sampleCount: report.sampleCount, logCount: report.logCount }, reason: "只读盘点源暂存；尚未导入业务表" });
    await client.query("COMMIT");
    return { batchId, reused: false };
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}
