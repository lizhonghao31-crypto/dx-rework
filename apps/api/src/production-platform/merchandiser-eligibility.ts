import type {PoolClient} from 'pg';
import {hasMemberModulePolicy,memberCanWriteModule} from '../access/member-module-policy.js';
import {DigitalProductionAccessPolicy} from './access-policy.js';
type DB=Pick<PoolClient,'query'>;
/** Same live role/member policy as the original default assignment. */
export async function lockEligibleMerchandiser(db:DB,userId:string,secondary=false):Promise<boolean>{
 if(!await new DigitalProductionAccessPolicy(db).lockActiveRole(userId,'order_merchandiser'))return false;
 const required=['sourcing:view','sourcing:inquiry:create','sourcing:contract:record',...(secondary?['supplier_contract_data:read']:[])];
 const capabilities=(await db.query("SELECT capability FROM role_capabilities WHERE role_code='order_merchandiser' AND capability=ANY($1::text[]) FOR SHARE",[required])).rows;
 if(!required.every(capability=>capabilities.some(row=>row.capability===capability))||!await memberCanWriteModule(db,userId,'sourcing'))return false;
 if(!await hasMemberModulePolicy(db))return true;
 await db.query("SELECT policy_key FROM access_security_policy WHERE policy_key='primary' FOR SHARE");
 return (await db.query("SELECT bool_and(todo_user_has_direct_role($1,'order_merchandiser',capability)) AS eligible FROM unnest($2::text[]) required(capability)",[userId,required])).rows[0]?.eligible===true;
}
