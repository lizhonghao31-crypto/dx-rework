import type { PoolClient } from "pg";
import { DIGITAL_SLA_PARAMETERS, validateDigitalSlaValues, type DigitalSlaValues } from "@dx-rework/contracts/digital-sla";

/** Existing task keys remain authoritative, including the original craft-confirmation key. */
export const slaPolicyKey = (parameter: string) => parameter === "development_craft_return" ? "development_craft_confirmation" : parameter === "external_pattern" ? "development_external_pattern" : parameter;
export const slaParameterKey = (policy: string) => policy === "development_material_recheck" ? "development_materials" : policy === "development_craft_confirmation" ? "development_craft_return" : policy === "development_external_pattern" ? "external_pattern" : policy;
type References = { storage: "policy_refs_v1"; policies: Record<string, { nodeKey: string; version: number }>; parameters: DigitalSlaValues };

/** Historical inline standards are immutable and remain readable; new publications only reference durations. */
export async function readSlaPolicyValues(client: Pick<PoolClient, "query">, stored: unknown): Promise<DigitalSlaValues> {
  if (!stored || typeof stored !== "object" || !("storage" in stored)) return validateDigitalSlaValues(stored);
  const refs = stored as References;
  if (refs.storage !== "policy_refs_v1" || !refs.policies || !refs.parameters) throw new Error("Invalid SLA policy references");
  const values: DigitalSlaValues = { ...refs.parameters };
  for (const [key, ref] of Object.entries(refs.policies)) {
    const definition = DIGITAL_SLA_PARAMETERS.find(p => p.key === key)?.defaultValue;
    if (!definition || !["duration", "included", "estimate", "unlimited", "order_date"].includes(definition.kind)
      || ref.nodeKey !== slaPolicyKey(key) || !Number.isSafeInteger(ref.version) || ref.version < 1 || key in values) throw new Error("Invalid SLA policy reference");
    const row = (await client.query("SELECT sla_seconds FROM digital_production_deadline_policies WHERE node_key=$1 AND version=$2", [ref.nodeKey, ref.version])).rows[0];
    if (!row) throw new Error(`Missing SLA policy: ${key}`);
    if (definition.kind === "unlimited" || definition.kind === "order_date") {
      if (row.sla_seconds !== null) throw new Error(`Unexpected SLA duration: ${key}`);
      values[key] = { kind: definition.kind };
    } else {
      if (row.sla_seconds === null) throw new Error(`Missing SLA policy duration: ${key}`);
      values[key] = { kind: definition.kind as "duration" | "included" | "estimate", minutes: Number(row.sla_seconds) / 60 };
    }
  }
  return validateDigitalSlaValues(values);
}

/** A bounded set of selected historical standards shares one exact-reference
 * read. The original per-standard reader and all its existing callers remain.
 */
export async function readSlaPolicyValuesMany(client:Pick<PoolClient,'query'>,stored:readonly unknown[]):Promise<DigitalSlaValues[]>{
 const references=new Map<string,{nodeKey:string;version:number}>();
 const prepared=stored.map(value=>{
  if(!value||typeof value!=='object'||!('storage'in value))return {inline:validateDigitalSlaValues(value)};
  const refs=value as References;if(refs.storage!=='policy_refs_v1'||!refs.policies||!refs.parameters)throw Error('Invalid SLA policy references');
  for(const [key,ref]of Object.entries(refs.policies)){
   const definition=DIGITAL_SLA_PARAMETERS.find(p=>p.key===key)?.defaultValue;
   if(!definition||!['duration','included','estimate','unlimited','order_date'].includes(definition.kind)||ref.nodeKey!==slaPolicyKey(key)||!Number.isSafeInteger(ref.version)||ref.version<1||key in refs.parameters)throw Error('Invalid SLA policy reference');
   references.set(JSON.stringify([ref.nodeKey,ref.version]),ref);
  }
  return {refs};
 });
 const keys=[...references.values()],rows=keys.length?(await client.query<{node_key:string;version:number;sla_seconds:string|null}>(`SELECT node_key,version,sla_seconds FROM digital_production_deadline_policies
  WHERE (node_key,version) IN(SELECT * FROM unnest($1::text[],$2::integer[]))`,[keys.map(ref=>ref.nodeKey),keys.map(ref=>ref.version)])).rows:[];
 const policies=new Map(rows.map(row=>[JSON.stringify([row.node_key,row.version]),row]));
 return prepared.map(item=>{
  if(item.inline)return item.inline;
  const values:DigitalSlaValues={...item.refs!.parameters};
  for(const [key,ref]of Object.entries(item.refs!.policies)){
   const definition=DIGITAL_SLA_PARAMETERS.find(p=>p.key===key)!.defaultValue,row=policies.get(JSON.stringify([ref.nodeKey,ref.version]));
   if(!row)throw Error(`Missing SLA policy: ${key}`);
   if(definition.kind==='unlimited'||definition.kind==='order_date'){if(row.sla_seconds!==null)throw Error(`Unexpected SLA duration: ${key}`);values[key]={kind:definition.kind};}
   else{if(row.sla_seconds===null)throw Error(`Missing SLA policy duration: ${key}`);values[key]={kind:definition.kind as 'duration'|'included'|'estimate',minutes:Number(row.sla_seconds)/60};}
  }
  return validateDigitalSlaValues(values);
 });
}

/** Called inside the publication transaction, after taking the shared publication lock. */
export async function storeSlaPolicyValues(client: PoolClient, values: DigitalSlaValues, actorId: string, reason: string): Promise<References> {
  const result: References = { storage: "policy_refs_v1", policies: {}, parameters: {} };
  const warning = values.warning_ratio;
  if (warning?.kind !== "ratio") throw new Error("Invalid SLA warning ratio");
  for (const definition of DIGITAL_SLA_PARAMETERS) {
    const value = values[definition.key]!;
    if (value.kind !== "duration" && value.kind !== "included" && value.kind !== "estimate" && value.kind !== "unlimited" && value.kind !== "order_date") {
      result.parameters[definition.key] = value;
      continue;
    }
    const nodeKey = slaPolicyKey(definition.key), seconds = "minutes" in value ? value.minutes * 60 : null;
    const previous = (await client.query("SELECT * FROM digital_production_deadline_policies WHERE node_key=$1 ORDER BY version DESC LIMIT 1", [nodeKey])).rows[0];
    // Later domain migrations may still seed their immutable version 1. Never occupy that
    // reserved seed for a not-yet-installed node during an earlier foundation publication.
    let version = Number(previous?.version ?? 1);
    if (!previous || (previous.sla_seconds === null ? null : Number(previous.sla_seconds)) !== seconds || Number(previous.warning_ratio) !== warning.percent / 100) {
      version++;
      await client.query(`INSERT INTO digital_production_deadline_policies(node_key,version,label,sla_seconds,warning_ratio,changed_by,note)
        VALUES($1,$2,$3,$4,$5,$6,$7)`, [nodeKey, version, definition.label, seconds, warning.percent / 100, actorId, reason]);
    }
    result.policies[definition.key] = { nodeKey, version };
  }
  return result;
}
