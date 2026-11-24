import type {Pool,PoolClient} from 'pg';
import type {TrustedActorContext} from '../tools/repositories.js';
import {acceptanceBusinessContext} from '../acceptance-clock/business-time.js';
import {isRootActor} from '../access/business-authority.js';

type Queryable=Pick<Pool|PoolClient,'query'>;

/** Read the existing verified binding for the secondary-craft approval queue. */
export async function readSecondaryCraftApprover(db:Queryable):Promise<string|null>{
 const {rows}=await db.query<{user_id:string}>(`SELECT binding.user_id
  FROM business_module_owner_bindings binding
  JOIN app_users person ON person.id=binding.user_id AND person.enabled AND NOT person.manual_access_disabled
  JOIN access_security_policy organization ON organization.policy_key='primary'
  JOIN identity_mappings identity ON identity.user_id=person.id AND identity.provider='dingtalk'
   AND identity.corp_id=organization.dingtalk_corp_id AND identity.active AND identity.employed
  WHERE binding.member_key='wu_yunfeng' AND NOT access_is_root_actor(person.id)
   AND EXISTS(SELECT 1 FROM user_role_assignments assignment JOIN business_roles role USING(role_code)
    WHERE assignment.user_id=person.id AND assignment.role_code='owner_group' AND assignment.revoked_at IS NULL AND role.enabled)
  LIMIT 2`);
 if(rows.length!==1)return null;
 const id=rows[0]!.user_id,context=acceptanceBusinessContext();
 return !context||await context.acceptsActor(id)?id:null;
}

/** Read-side eligibility only. Approvals must revalidate inside their write transaction. */
export async function canReadSecondaryCraftApprovalQueue(db:Queryable,actor:TrustedActorContext):Promise<boolean>{
 return !isRootActor(actor)&&actor.actorRoles.includes('owner_group')&&await readSecondaryCraftApprover(db)===actor.actorId;
}

/** Write callers must keep the membership locks until the quotation transaction commits. */
export async function lockSecondaryCraftApprover(db:Queryable):Promise<string|null>{
 const candidate=await readSecondaryCraftApprover(db);
 if(!candidate)return null;
 await db.query("SELECT pg_advisory_xact_lock_shared(hashtext('dx_rework:owner_group_guard'))");
 // Directory synchronization locks the identity before the account.
 const identity=await db.query(`SELECT identity.id FROM identity_mappings identity
  JOIN access_security_policy organization ON organization.policy_key='primary'
   AND organization.dingtalk_corp_id=identity.corp_id
  WHERE identity.user_id=$1 AND identity.provider='dingtalk' AND identity.active AND identity.employed
  FOR SHARE OF identity,organization`,[candidate]);
 if(identity.rowCount!==1)return null;
 const eligible=await db.query(`SELECT person.id FROM app_users person
  JOIN user_role_assignments assignment ON assignment.user_id=person.id
   AND assignment.role_code='owner_group' AND assignment.revoked_at IS NULL
  JOIN business_roles role ON role.role_code=assignment.role_code AND role.enabled
  WHERE person.id=$1 AND person.enabled AND NOT person.manual_access_disabled
  FOR SHARE OF person,assignment,role`,[candidate]);
 return eligible.rowCount===1&&await readSecondaryCraftApprover(db)===candidate?candidate:null;
}
