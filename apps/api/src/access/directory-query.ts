import type {Pool,PoolClient} from "pg";
import {SUPPLIER_DIRECTORY_TYPE_LABELS,type PeopleDirectoryQuery,type SupplierDirectoryQuery} from "@dx-rework/contracts/master-data-pages";
import type {TrustedActorContext} from "../tools/repositories.js";
import type {AccessMasterDataService} from "./service.js";

/** No cached actors/results. Counts, IDs and selected enrichment share one native snapshot. */
export class AccessDirectoryQuery{
 constructor(private readonly db:Pool,private readonly service:AccessMasterDataService){}
 private async read<T>(work:(client:PoolClient)=>Promise<T>){
  const client=await this.db.connect();try{await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");const value=await work(client);await client.query("COMMIT");return value;}catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
 }
 people(input:PeopleDirectoryQuery,actor:TrustedActorContext){return this.read(async client=>{
  const result=await client.query<{total:string;internal_count:string;temporary_count:string;ids:string[]}>(`
   WITH matched AS MATERIALIZED (
    SELECT p.person_id,p.person_type,p.display_name,
      row_number() OVER (PARTITION BY p.person_type ORDER BY p.display_name,p.person_id) ordinal
    FROM business_people p
    WHERE CASE WHEN $1::text='' THEN true ELSE position(lower($1::text) in lower(
      p.display_name||' '||coalesce(p.temporary_code,'')||' '||coalesce(p.temporary_remark,'')||' '||
      coalesce((SELECT string_agg(a.alias,' ' ORDER BY a.created_at,a.alias) FROM business_person_aliases a WHERE a.person_id=p.person_id AND a.revoked_at IS NULL),'')||' '||
      CASE WHEN p.person_type='temporary' THEN '临时工' ELSE '内部工人 内部员工' END||' '||
      CASE WHEN p.active THEN '有效 可分配' ELSE '停用' END))>0 END
   ), selected AS MATERIALIZED (
    SELECT person_id FROM matched WHERE (person_type='internal' AND ordinal>$2 AND ordinal<=$2+15) OR (person_type='temporary' AND ordinal>$3 AND ordinal<=$3+15)
   )
   SELECT (SELECT count(*)::text FROM business_people) total,
     (SELECT count(*)::text FROM matched WHERE person_type='internal') internal_count,
     (SELECT count(*)::text FROM matched WHERE person_type='temporary') temporary_count,
     coalesce(array_agg(selected.person_id) FILTER(WHERE selected.person_id IS NOT NULL),'{}'::uuid[]) ids
   FROM selected`,[input.q,(input.internalPage-1)*15,(input.temporaryPage-1)*15]);
  const head=result.rows[0]!,items=await this.service.listPeople({includeInactive:true,includeRevokedAliases:true,personIds:head.ids},actor,client),internalCount=Number(head.internal_count),temporaryCount=Number(head.temporary_count);
  return {pageSize:15 as const,totalCount:Number(head.total),matchedCount:internalCount+temporaryCount,internal:{page:input.internalPage,totalCount:internalCount,items:items.filter(p=>p.personType==="internal")},temporary:{page:input.temporaryPage,totalCount:temporaryCount,items:items.filter(p=>p.personType==="temporary")}};
 });}
 suppliers(input:SupplierDirectoryQuery){return this.read(async client=>{
  const result=await client.query<{total:string;ids:string[];crafts:string[]}>(`
   WITH matched AS MATERIALIZED (
    SELECT supplier_id,supplier_name,supplier_code FROM current_supplier_catalog s
    WHERE ($1::text='all' OR s.supplier_type=$1)
      AND ($2::text='all' OR s.active=($2='active'))
      AND ($3::text='' OR $3=ANY(s.supported_crafts))
      AND ($4::text='all' OR ($4='missing')=(
        coalesce(s.address,'')='' OR coalesce(s.contract_entity_name,'')='' OR coalesce(s.party_b_representative,'')='' OR coalesce(s.payee_name,'')='' OR coalesce(s.bank_account,'')='' OR coalesce(s.bank_name,'')=''))
      AND ($5::text='' OR position(lower($5::text) in lower(concat_ws(' ',s.supplier_name,s.supplier_code,($7::jsonb->>s.supplier_type),array_to_string(s.supported_crafts,' '))))>0)
   ), selected AS MATERIALIZED (
    SELECT supplier_id FROM matched ORDER BY supplier_name,supplier_code LIMIT 15 OFFSET $6
   )
   SELECT (SELECT count(*)::text FROM matched) total,
    coalesce(array_agg(selected.supplier_id) FILTER(WHERE selected.supplier_id IS NOT NULL),'{}'::uuid[]) ids,
    ARRAY(SELECT DISTINCT craft FROM current_supplier_catalog s CROSS JOIN LATERAL unnest(s.supported_crafts) craft ORDER BY craft) crafts
   FROM selected`,[input.type,input.status,input.craft,input.completeness,input.q,(input.page-1)*15,JSON.stringify(SUPPLIER_DIRECTORY_TYPE_LABELS)]);
  const head=result.rows[0]!,items=await this.service.listSuppliers(true,head.ids,client);
  return {page:input.page,pageSize:15 as const,totalCount:Number(head.total),crafts:head.crafts.sort((a,b)=>a.localeCompare(b,"zh-CN")),items};
 });}
}
