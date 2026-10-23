import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { PoolClient } from "pg";
import {
  DIGITAL_SLA_RULE_VERSION, validateDigitalSlaSnapshot, validateDigitalSlaValues,
  type DigitalSlaSnapshot, type DigitalSlaValues,
} from "@dx-rework/contracts/digital-sla";

// Internal transaction-bound persistence. No route is exposed by this foundation.
// The publishing/application service must check actor and order scope before calling.
export class SlaVersionConflict extends Error {}
export class SlaIdempotencyConflict extends Error {}
const equal = isDeepStrictEqual;
const reasonText = (reason: string) => {
  const value = reason.trim();
  if (!value || value.length > 1000) throw new Error("SLA change reason required (max 1000 characters)");
  return value;
};
export type SlaConfiguration = {
  configurationId: string; version: number; values: DigitalSlaValues; createdBy: string; reason: string;
};
export type SlaOrderSnapshot = {
  snapshotId: string; orderId: string; revision: number; configurationId: string;
  snapshot: DigitalSlaSnapshot; createdBy: string; reason: string;
};
export class SlaConfigurationRepository {
  constructor(private readonly transaction: PoolClient) {}

  async current(): Promise<SlaConfiguration | null> {
    const row = (await this.transaction.query("SELECT * FROM digital_sla_configurations ORDER BY version DESC LIMIT 1")).rows[0];
    return row ? { configurationId: row.configuration_id, version: row.version,
      values: validateDigitalSlaValues(row.values_json), createdBy: row.created_by, reason: row.reason } : null;
  }

  async orderSnapshot(orderId: string, revision?: number): Promise<SlaOrderSnapshot | null> {
    if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 1)) throw new Error("Invalid snapshot revision");
    const row = (await this.transaction.query(`SELECT * FROM digital_sla_order_snapshots
      WHERE production_order_id=$1 AND ($2::integer IS NULL OR revision=$2)
      ORDER BY revision DESC LIMIT 1`, [orderId, revision ?? null])).rows[0];
    return row ? { snapshotId: row.snapshot_id, orderId: row.production_order_id, revision: row.revision,
      configurationId: row.configuration_id, createdBy: row.created_by, reason: row.reason,
      snapshot: validateDigitalSlaSnapshot({ ruleVersion: row.rule_version, parameters: row.parameters_json }) } : null;
  }

  async publish(input: { expectedVersion: number; values: DigitalSlaValues; actorId: string; reason: string; requestKey: string }): Promise<SlaConfiguration> {
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) throw new Error("Invalid expected version");
    const values = validateDigitalSlaValues(input.values);
    const reason = reasonText(input.reason);
    // Locks are transaction scoped. A caller must BEGIN before using this repository.
    await this.transaction.query("LOCK TABLE digital_sla_configurations IN SHARE ROW EXCLUSIVE MODE");
    const prior = (await this.transaction.query("SELECT * FROM digital_sla_configurations WHERE request_key=$1", [input.requestKey])).rows[0];
    if (prior) {
      if (prior.created_by !== input.actorId || prior.reason !== reason || prior.version !== input.expectedVersion + 1 || !equal(prior.values_json, values)) throw new SlaIdempotencyConflict("SLA request key reused with different input");
      return { configurationId: prior.configuration_id, version: prior.version, values: prior.values_json, createdBy: prior.created_by, reason: prior.reason };
    }
    const version = Number((await this.transaction.query("SELECT COALESCE(max(version),0) AS version FROM digital_sla_configurations")).rows[0].version);
    if (version !== input.expectedVersion) throw new SlaVersionConflict("SLA configuration changed; reload before publishing");
    const id = randomUUID();
    await this.transaction.query(`INSERT INTO digital_sla_configurations(configuration_id,version,rule_version,values_json,created_by,reason,request_key)
      VALUES($1,$2,$3,$4,$5,$6,$7)`, [id, version + 1, DIGITAL_SLA_RULE_VERSION, JSON.stringify(values), input.actorId, reason, input.requestKey]);
    return { configurationId: id, version: version + 1, values, createdBy: input.actorId, reason };
  }

  async appendOrder(input: { orderId: string; expectedRevision: number; configurationId: string; snapshot: DigitalSlaSnapshot; actorId: string; reason: string; requestKey: string }): Promise<SlaOrderSnapshot> {
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) throw new Error("Invalid expected revision");
    const snapshot = validateDigitalSlaSnapshot(input.snapshot);
    const reason = reasonText(input.reason);
    // Scope lock serializes only this order and never changes the immutable root.
    const root = await this.transaction.query("SELECT production_order_id FROM production_order_roots WHERE production_order_id=$1 FOR UPDATE", [input.orderId]);
    if (!root.rowCount) throw new Error("SLA order not found");
    const config = (await this.transaction.query("SELECT * FROM digital_sla_configurations WHERE configuration_id=$1", [input.configurationId])).rows[0];
    if (!config) throw new Error("SLA configuration not found");
    for (const [key, row] of Object.entries(snapshot.parameters)) {
      if (row.source === "global" && (row.sourceVersion !== config.version || !equal(row.value, config.values_json[key]))) throw new Error("Snapshot global source does not match configuration");
    }
    const prior = (await this.transaction.query("SELECT * FROM digital_sla_order_snapshots WHERE request_key=$1", [input.requestKey])).rows[0];
    if (prior) {
      if (prior.production_order_id !== input.orderId || prior.configuration_id !== input.configurationId || prior.created_by !== input.actorId || prior.reason !== reason || prior.revision !== input.expectedRevision + 1 || !equal(prior.parameters_json, snapshot.parameters)) throw new SlaIdempotencyConflict("SLA snapshot key reused with different input");
      return { snapshotId: prior.snapshot_id, orderId: input.orderId, revision: prior.revision, configurationId: prior.configuration_id, snapshot, createdBy: prior.created_by, reason: prior.reason };
    }
    const revision = Number((await this.transaction.query("SELECT COALESCE(max(revision),0) AS revision FROM digital_sla_order_snapshots WHERE production_order_id=$1", [input.orderId])).rows[0].revision);
    if (revision !== input.expectedRevision) throw new SlaVersionConflict("SLA order changed; preview again");
    const id = randomUUID();
    await this.transaction.query(`INSERT INTO digital_sla_order_snapshots(snapshot_id,production_order_id,revision,configuration_id,rule_version,parameters_json,created_by,reason,request_key)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [id, input.orderId, revision + 1, input.configurationId, snapshot.ruleVersion, JSON.stringify(snapshot.parameters), input.actorId, reason, input.requestKey]);
    return { snapshotId: id, orderId: input.orderId, revision: revision + 1, configurationId: input.configurationId, snapshot, createdBy: input.actorId, reason };
  }
}
