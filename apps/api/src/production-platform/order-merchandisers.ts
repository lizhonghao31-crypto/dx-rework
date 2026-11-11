import type {PoolClient} from 'pg';
import {lockEligibleMerchandiser} from './merchandiser-eligibility.js';
import {ApplicationError} from '../platform/errors.js';
type DB=Pick<PoolClient,'query'>;
/** Copy once from the locked customer default; a future settings update never
 * touches this order's membership. Live authority is checked at each use.
 */
export async function inheritCustomerSecondaryMerchandisers(db:DB,code:string,orderId:string,primary:string|null){
 const ids=(await db.query<{user_id:string}>('SELECT user_id FROM digital_customer_secondary_merchandisers WHERE customer_code=$1 ORDER BY position,user_id FOR SHARE',[code])).rows.map(r=>r.user_id).filter(id=>id!==primary);
 for(const id of ids)if(!await lockEligibleMerchandiser(db,id,true))throw new ApplicationError('DIGITAL_PRODUCTION_CONFLICT','客户默认副跟单已失效，请主管更新跟单设置后再创建订单',409);
 for(const [position,id]of ids.entries())await db.query('INSERT INTO digital_order_secondary_merchandisers(production_order_id,user_id,position) VALUES($1,$2,$3)',[orderId,id,position+1]);
 return ids;
}
/** Already-authorized order reads use the complete relationship in one query,
 * including the legacy external case, never one name lookup per person.
 */
type Person={id:string;name:string|null};
function merchandiserQuery(includePrimary:boolean){return `SELECT p.id,p.display_name AS name FROM (
  SELECT user_id,min(position) AS position FROM (
   SELECT s.user_id,s.position FROM digital_order_secondary_merchandisers s WHERE s.production_order_id=$1
   UNION ALL SELECT primary_merchandiser_id,-1 FROM digital_production_orders WHERE production_order_id=$1 AND ${includePrimary?'true':'false'}
   UNION ALL SELECT selected.user_id,1000+selected.position::int FROM digital_production_child_links l
    JOIN sourcing_cases c ON c.sourcing_case_id=l.child_id AND c.deleted_at IS NULL
    CROSS JOIN LATERAL unnest(sourcing_additional_merchandiser_ids(c.sourcing_case_id)) WITH ORDINALITY selected(user_id,position)
    WHERE l.production_order_id=$1 AND l.module='sourcing'
  ) related GROUP BY user_id
 ) ids JOIN app_users p ON p.id=ids.user_id WHERE ${includePrimary?'true':'false'} OR p.id IS DISTINCT FROM (SELECT primary_merchandiser_id FROM digital_production_orders WHERE production_order_id=$1)
 ORDER BY ids.position,p.id`;}
export async function readOrderSecondaryMerchandisers(db:DB,orderId:string,includePrimary=false):Promise<Person[]>{
 return (await db.query<Person>(merchandiserQuery(includePrimary),[orderId])).rows;
}
/** Factual names only, bounded to the caller's already-authorized IDs and RR
 * client. The caller owns the request-local map; no grant or DTO is cached.
 */
export async function readOrderMerchandisersByOrder(db:DB,ids:readonly string[]):Promise<Map<string,Person[]>>{
 const unique=[...new Set(ids)],result=new Map<string,Person[]>(unique.map(id=>[id,[]]));
 for(let offset=0;offset<unique.length;offset+=32){
  const rows=(await db.query<Person&{order_id:string}>(`SELECT requested.id AS order_id,people.* FROM unnest($1::uuid[]) requested(id)
   CROSS JOIN LATERAL (${merchandiserQuery(true).replace(/\$1\b/g,'requested.id')}) people`,[unique.slice(offset,offset+32)])).rows;
  for(const {order_id,...person}of rows)result.get(order_id)!.push(person);
 }
 return result;
}
