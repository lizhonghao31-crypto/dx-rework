import type {Pool,PoolClient} from 'pg';
import {DIGITAL_SLA_PARAMETERS} from '@dx-rework/contracts/digital-sla';
import {SlaHistoryQuerySchema,slaHistoryValueEqual,type SlaHistoryQuery,type SlaHistoryRow,type SlaHistoryPage,type SlaVersionDetail,type SlaApplicationCandidatesQuery,type SlaApplicationCandidatesPage} from '@dx-rework/contracts/sla-settings-history';
import type {TrustedActorContext} from '../tools/repositories.js';
import {ApplicationError} from '../platform/errors.js';
import {assertSlaSettingsActor,assertSlaSettingsReadActor} from './sla-settings-authority.js';
import {OrderClosureService} from './order-closure-service.js';
import {acceptanceIncludesNative} from '../acceptance-clock/business-time.js';
import {readSlaPolicyValuesMany} from './sla-policy-values.js';
type Row={version:number;created_at:Date|string;display_name:string|null;reason:string;policy_refs_json:unknown;values_json:unknown};
const row=(value:Row):SlaHistoryRow=>({version:value.version,publishedAt:new Date(value.created_at).toISOString(),publishedBy:value.display_name,reason:value.reason,scope:'new_orders'});
/** Immutable published standards, never an order fact/history writer. */
export class SlaSettingsHistoryService{
 constructor(private readonly database:Pool){}
 private async read<T>(actor:TrustedActorContext,work:(db:PoolClient)=>Promise<T>){const db=await this.database.connect();try{await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await assertSlaSettingsReadActor(db,actor);const result=await work(db);await db.query('COMMIT');return result;}catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}}
 async list(actor:TrustedActorContext,input:SlaHistoryQuery):Promise<SlaHistoryPage>{
  const query=SlaHistoryQuerySchema.parse(input);return this.read(actor,async db=>{
   const totals=(await db.query<{total:number;current:number|null}>('SELECT count(*)::int AS total,max(version) AS current FROM digital_sla_configurations')).rows[0]!;
   const rows=(await db.query<Row>(`SELECT c.version,c.created_at,c.reason,u.display_name FROM digital_sla_configurations c LEFT JOIN app_users u ON u.id=c.created_by
    WHERE ($1::integer IS NULL OR c.version<$1) ORDER BY c.version DESC LIMIT $2`,[query.beforeVersion??null,query.pageSize+1])).rows,items=rows.slice(0,query.pageSize).map(row);
   return {currentVersion:totals.current??0,total:totals.total,items,nextBeforeVersion:rows.length>query.pageSize?items.at(-1)!.version:null};
  });
 }
 /** Lightweight metadata first. The original signed preview remains the only
  * proof that a selected unfinished node can change. No full-order SLA loop. */
 async candidates(actor:TrustedActorContext,input:SlaApplicationCandidatesQuery):Promise<SlaApplicationCandidatesPage>{
  return this.read(actor,async db=>{
   await assertSlaSettingsActor(db,actor);
   const rows=(await db.query<{production_order_id:string;design_style_no:string;customer_code:string;pos:string[];version:number|null;has_plan:boolean;has_snapshot:boolean;closed:boolean;cancelled:boolean}>(`SELECT o.production_order_id,o.design_style_no,o.customer_code,
    ARRAY(SELECT DISTINCT coalesce(l.po_number,l.formal_style_no) FROM digital_production_po_lines l WHERE l.production_order_id=o.production_order_id AND coalesce(l.po_number,l.formal_style_no) IS NOT NULL ORDER BY 1) AS pos,
    (SELECT c.version FROM digital_sla_order_snapshots s LEFT JOIN digital_sla_configurations c USING(configuration_id) WHERE s.production_order_id=o.production_order_id ORDER BY s.revision DESC LIMIT 1) AS version,
    EXISTS(SELECT 1 FROM digital_sla_plans p WHERE p.production_order_id=o.production_order_id) AS has_plan,
    EXISTS(SELECT 1 FROM digital_sla_order_snapshots s WHERE s.production_order_id=o.production_order_id) AS has_snapshot,
    EXISTS(SELECT 1 FROM digital_order_closures c WHERE c.production_order_id=o.production_order_id) AS closed,
    EXISTS(SELECT 1 FROM digital_production_resource_lifecycle r WHERE ((r.resource_kind='order' AND r.resource_id=o.production_order_id) OR (r.resource_kind='source' AND r.resource_id=o.source_id)) AND r.state='cancelled') AS cancelled
    FROM digital_production_orders o WHERE ($1='' OR strpos(lower(o.design_style_no),lower($1))>0 OR strpos(lower(o.customer_code),lower($1))>0 OR EXISTS(SELECT 1 FROM digital_production_po_lines l WHERE l.production_order_id=o.production_order_id AND strpos(lower(coalesce(l.po_number,l.formal_style_no,'')),lower($1))>0)) ORDER BY o.created_at DESC,o.production_order_id DESC`,[input.search])).rows;
   const visible=[];for(const value of rows)if(await acceptanceIncludesNative(this.database,value.production_order_id,db))visible.push(value);
   const items=[];for(const value of visible.slice((input.page-1)*15,input.page*15)){
    let reason=value.cancelled?'已取消':value.closed?'已结案':!value.has_plan||!value.has_snapshot?'无有效原采用计划，不能补造历史标准':null;
    // Only the current page reads original completion facts. Packing alone is
    // insufficient: receipt differences, quality, rework and pending work count.
    if(reason===null){try{if((await new OrderClosureService(this.database).read(actor,value.production_order_id,db)).stage==='本期装箱完成')reason='已正常完成';}catch(error){if(error instanceof ApplicationError&&error.statusCode===404)reason='订单已变化，请重新查询';else throw error;}}
    items.push({orderId:value.production_order_id,designStyleNo:value.design_style_no,customerCode:value.customer_code,pos:value.pos,adoptedVersion:value.version,selectable:reason===null,reason});
   }
   return {page:input.page,pageSize:15,total:visible.length,items};
  });
 }
 async version(actor:TrustedActorContext,version:number):Promise<SlaVersionDetail>{
  if(!Number.isSafeInteger(version)||version<1)throw new ApplicationError('VALIDATION_ERROR','请选择已发布的标准版本',400);
  return this.read(actor,async db=>{
   const rows=(await db.query<Row>(`SELECT c.*,u.display_name FROM digital_sla_configurations c LEFT JOIN app_users u ON u.id=c.created_by
    WHERE c.version=$1 OR c.version=(SELECT max(version) FROM digital_sla_configurations) ORDER BY c.version DESC`,[version])).rows,selected=rows.find(value=>value.version===version);
   if(!selected)throw new ApplicationError('NOT_FOUND','标准版本不存在',404);
   const values=await readSlaPolicyValuesMany(db,rows.map(value=>value.policy_refs_json??value.values_json)),historical=values[rows.indexOf(selected)]!,current=values[0]!;
   return {...row(selected),currentVersion:rows[0]!.version,values:historical,differences:DIGITAL_SLA_PARAMETERS.filter(p=>!slaHistoryValueEqual(p.key,historical[p.key]!,current[p.key]!)).map(p=>({key:p.key,label:p.label,historical:historical[p.key]!,current:current[p.key]!}))};
  });
 }
}
