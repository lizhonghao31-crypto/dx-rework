import {appendCurrentSettingsSet} from './sla-settings-set-repository.js';
import type { PoolClient } from "pg";
import { createHash } from "node:crypto";
import { DIGITAL_SLA_PARAMETERS, validateDigitalSlaValues, type DigitalSlaValues } from "@dx-rework/contracts/digital-sla";
import type { TrustedActorContext } from "../tools/repositories.js";
import {assertSlaSettingsActor} from './sla-settings-authority.js';
import { SlaConfigurationRepository, SlaVersionConflict } from "./sla-configuration-repository.js";
import { slaParameterKey } from "./sla-policy-values.js";
import { ApplicationError } from "../platform/errors.js";

/** One authorized publication path. Existing order snapshots are never implicitly reapplied. */
export class SlaConfigurationService {
  async publishNewStandard(client: PoolClient, actor: TrustedActorContext, input: {
    expectedVersion: number; values: DigitalSlaValues; reason: string; requestKey: string;
  }) {
    await assertSlaSettingsActor(client,actor,true);
    const result=await new SlaConfigurationRepository(client).publish({ ...input, values: validateDigitalSlaValues(input.values), actorId: actor.actorId });
    await appendCurrentSettingsSet(client,actor.actorId,input.requestKey);
    return result;
  }

  async changeLegacyPolicy(client: PoolClient, actor: TrustedActorContext, nodeKey: string, input: {
    expectedVersion: number; slaHours: number | null; warningRatio: number; note: string;
  }, requestKey: string) {
    await assertSlaSettingsActor(client,actor,true);
    const parameterKey = slaParameterKey(nodeKey);
    const parameter = DIGITAL_SLA_PARAMETERS.find(p => p.key === parameterKey);
    if (!parameter) throw new Error("Policy is outside the SLA parameter catalog");
    await client.query("LOCK TABLE digital_sla_configurations IN SHARE ROW EXCLUSIVE MODE");
    const prior = (await client.query("SELECT version FROM digital_production_deadline_policies WHERE node_key=$1 ORDER BY version DESC LIMIT 1", [nodeKey])).rows[0];
    if (Number(prior?.version) !== input.expectedVersion) throw new SlaVersionConflict("时效参数已更新，请刷新");
    const current = await new SlaConfigurationRepository(client).initialStandard(actor.actorId);
    const values = structuredClone(current.values), value = values[parameterKey]!;
    if (value.kind === "duration" || value.kind === "included" || value.kind === "estimate") {
      if (input.slaHours === null) throw new ApplicationError("DIGITAL_TASK_CONFLICT", "此节点必须保留时效，不能清空关闭", 409);
      values[parameterKey] = { kind: value.kind, minutes: input.slaHours * 60 };
    } else if (input.slaHours !== null) throw new ApplicationError("DIGITAL_TASK_CONFLICT", "此节点没有独立工时，不能通过设置新增限时", 409);
    // The legacy editor only represents one node. It must not silently change the global warning ratio.
    const warning = values.warning_ratio;
    if (warning?.kind !== "ratio" || input.warningRatio !== warning.percent / 100) throw new ApplicationError("DIGITAL_TASK_CONFLICT", "临期比例为整套标准参数，请在统一时效设置中调整", 409);
    const token = createHash("sha256").update(JSON.stringify([actor.actorId, "task-policy", nodeKey, requestKey])).digest("hex");
    const publicationKey = `${token.slice(0, 8)}-${token.slice(8, 12)}-${token.slice(12, 16)}-${token.slice(16, 20)}-${token.slice(20, 32)}`;
    const published = await this.publishNewStandard(client, actor, { expectedVersion: current.version, values, reason: input.note.trim() || `调整${parameter.label}新单标准`, requestKey: publicationKey });
    const next = (await client.query("SELECT version FROM digital_production_deadline_policies WHERE node_key=$1 ORDER BY version DESC LIMIT 1", [nodeKey])).rows[0];
    return { nodeKey, version: Number(next.version), configurationVersion: published.version, affectedTasks: 0, scope: "new_orders" as const };
  }
}
