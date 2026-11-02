import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { DIGITAL_SLA_PARAMETERS, validateDigitalSlaValues, type DigitalSlaValues } from '@dx-rework/contracts/digital-sla';
import type { TrustedActorContext } from '../tools/repositories.js';
import { ApplicationError } from '../platform/errors.js';
import { assertSlaSettingsActor, assertSlaSettingsReadActor } from './sla-settings-authority.js';
import { SlaPreviewTokens } from './sla-preview-token.js';
import { SlaConfigurationRepository, SlaVersionConflict, SlaIdempotencyConflict } from './sla-configuration-repository.js';
import { SlaConfigurationService } from './sla-configuration-service.js';
export type StandardDraft = {
    expectedVersion: number;
    values: DigitalSlaValues;
    reason: string;
};
const conflict = () => new ApplicationError('DIGITAL_TASK_CONFLICT', '现行标准或草稿已改变，请重新预览后应用', 409);
const ordered = (values: DigitalSlaValues) => DIGITAL_SLA_PARAMETERS.map(p => [p.key, values[p.key]]);
const token = (actor: TrustedActorContext, draft: StandardDraft) => createHash('sha256').update(JSON.stringify([actor.actorId, draft.expectedVersion, ordered(draft.values), draft.reason])).digest('hex');
function checked(input: StandardDraft): StandardDraft {
    try {
        if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0 || !input.reason.trim() || input.reason.trim().length > 1000)
            throw new Error();
        return { ...input, reason: input.reason.trim(), values: validateDigitalSlaValues(input.values) };
    }
    catch {
        throw new ApplicationError('VALIDATION_ERROR', '请检查时长、单位、比例及内含项；内含目标合计不能超过所属窗口', 400);
    }
}
/** Transaction-bound settings facade. Does not edit order snapshots or historical tasks. */
export class SlaSettingsService {
    private readonly tokens: SlaPreviewTokens;
    constructor(secret?: string) { this.tokens = new SlaPreviewTokens(secret); }
    async read(client: PoolClient, actor: TrustedActorContext, version?: number) {
        await assertSlaSettingsReadActor(client, actor);
        const repo = new SlaConfigurationRepository(client), current = await repo.current(version);
        if (version !== undefined && !current)
            throw new ApplicationError('NOT_FOUND', '标准版本不存在', 404);
        return { version: current?.version ?? 0, values: current?.values ?? await repo.bootstrapValues(), scope: 'new_orders' as const,
            history: (await client.query('SELECT version,reason,created_by FROM digital_sla_configurations ORDER BY version DESC LIMIT 20')).rows };
    }
    async preview(client: PoolClient, actor: TrustedActorContext, input: StandardDraft) {
        await assertSlaSettingsActor(client, actor);
        const draft = checked(input), current = await this.read(client, actor);
        if (current.version !== draft.expectedVersion)
            throw conflict();
        const changes = DIGITAL_SLA_PARAMETERS.filter(p => JSON.stringify(current.values[p.key]) !== JSON.stringify(draft.values[p.key]))
            .map(p => ({ key: p.key, label: p.label, before: current.values[p.key]!, after: draft.values[p.key]! }));
        if (!changes.length)
            throw new ApplicationError('VALIDATION_ERROR', '没有需要发布的参数变化', 400);
        return { token: this.tokens.issue(token(actor, draft)), version: current.version, scope: 'new_orders' as const, changes, existingOrdersChanged: 0 };
    }
    async publish(client: PoolClient, actor: TrustedActorContext, input: StandardDraft & {
        previewToken: string;
    }, requestKey: string) {
        await assertSlaSettingsActor(client, actor, true);
        const draft = checked(input);
        // Same transaction serializes preview revalidation and canonical policy publication.
        await client.query('LOCK TABLE digital_sla_configurations IN SHARE ROW EXCLUSIVE MODE');
        const retry = (await client.query('SELECT 1 FROM digital_sla_configurations WHERE request_key=$1', [requestKey])).rowCount;
        if (!retry) {
            this.tokens.verify(input.previewToken, token(actor, draft));
            await this.preview(client, actor, draft);
        }
        try {
            const result = await new SlaConfigurationService().publishNewStandard(client, actor, { ...draft, requestKey });
            return { version: result.version, scope: 'new_orders' as const, existingOrdersChanged: 0 };
        }
        catch (error) {
            if (error instanceof SlaVersionConflict || error instanceof SlaIdempotencyConflict)
                throw conflict();
            throw error;
        }
    }
}
