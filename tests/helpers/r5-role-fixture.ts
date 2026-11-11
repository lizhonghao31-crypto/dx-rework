import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import type {TrustedActorContext} from '../../apps/api/src/tools/repositories.js';
import type {AccessMasterDataService} from '../../apps/api/src/access/service.js';
/** Dedicated users inside the already marked owned test schema. The original
 * role command supplies its audit/guard context; no trigger is disabled and no
 * existing seeded persona gains or loses a role for these tests.
 */
export async function r5RoleFixture(db:Pool,access:AccessMasterDataService,root:TrustedActorContext,role:string){
 const id=randomUUID(),corp=(await db.query("SELECT dingtalk_corp_id FROM access_security_policy WHERE policy_key='primary'")).rows[0].dingtalk_corp_id;
 await db.query('INSERT INTO app_users(id,display_name,enabled,manual_access_disabled) VALUES($1,$2,true,false)',[id,'TEST R5 '+role+' '+id.slice(0,6)]);
 await db.query("INSERT INTO identity_mappings(id,user_id,provider,corp_id,provider_user_id,union_id,active,employed,last_verified_at) VALUES($1,$2,'dingtalk',$3,$4,$5,true,true,CURRENT_TIMESTAMP)",[randomUUID(),id,corp,'uat-r5-'+id,'uat-union-r5-'+id]);
 const {assignmentId}=await access.assignRole(root,{userId:id,roleCode:role,reason:'TEST R5 dedicated native role fixture'});
 const capabilities=(await db.query<{capability:string}>('SELECT capability FROM role_capabilities WHERE role_code=$1 ORDER BY capability',[role])).rows.map(row=>row.capability);
 const actor:TrustedActorContext={actorId:id,actorRoles:[role],authorizationCapability:'digital_production:view',authorizationCapabilities:capabilities,requestId:randomUUID()};
 return {actor,assignmentId};
}
