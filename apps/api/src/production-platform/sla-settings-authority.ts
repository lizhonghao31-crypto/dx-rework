import type { PoolClient } from 'pg';
import type { TrustedActorContext } from '../tools/repositories.js';
import { isRootActor } from '../access/business-authority.js';
import { DigitalProductionAccessPolicy, digitalForbidden } from './access-policy.js';
/** Original three roles only. A stale request role cannot survive revocation. */
export async function assertSlaSettingsActor(db: Pick<PoolClient, 'query'>, actor: TrustedActorContext, write = false) {
    if (isRootActor(actor))
        return;
    const policy = new DigitalProductionAccessPolicy(db);
    for (const role of ['production_management', 'owner_group'])
        if (actor.actorRoles.includes(role) && await (write ? policy.lockActiveRole(actor.actorId, role) : policy.activeRole(actor.actorId, role)))
            return;
    digitalForbidden();
}
