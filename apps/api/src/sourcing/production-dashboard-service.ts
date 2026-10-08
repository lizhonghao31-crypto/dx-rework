import { addProductionChase, readProductionDays } from "./production-chase.js";
import { ProductionAnalysisQuerySchema } from "@dx-rework/contracts";
import { readProductionAnalysis } from "./production-analysis.js";
import { productionNotExcluded } from "./production-visibility.js";
import type { Pool, PoolClient } from "pg";
import { calculateProductionProgress, productionProgressRank, shanghaiDay, type ProductionProgressFacts } from "@dx-rework/domain";
import { ProductionDashboardQuerySchema, ProductionDashboardSchema, ProductionDashboardDetailSchema,
  type ProductionDashboardItem, type ProductionDashboardQuery, type ProductionDashboardEvent } from "@dx-rework/contracts";
import { ApplicationError } from "../platform/errors.js";
import type { TrustedActorContext } from "../tools/repositories.js";
import { selectProduction, selectFactoryProduction, toOrder, type ProductionRow } from "./sourcing-production-service.js";
import { type ProductionReportingService, canReadProductionReporting, productionVisibility, factoryProductionVisibility, productionVisibilityArgs } from "./production-reporting-service.js";

type FactsRow = {id:string;status:ProductionProgressFacts["status"];quantity:number;completed_quantity:number;first_on:string|null;due:string|null;last_at:Date|null;completed_on:string|null};
const iso = (date:Date|string) => new Date(date).toISOString();
const progress = (row:FactsRow, asOf:string) => calculateProductionProgress({status:row.status,quantity:row.quantity,
  completedQuantity:row.completed_quantity,firstReportedOn:row.first_on,deliveryDate:row.due,lastUpdatedAt:row.last_at?iso(row.last_at):null,completedOn:row.completed_on},asOf);
// One shared calculator serves listing, filtering, sorting, detail and future todo consumers.
export function selectDashboardPage(items:ProductionDashboardItem[],input:ProductionDashboardQuery) {
  const q=input.q?.trim().toLocaleLowerCase()??"";
  const filtered=items.filter(({order,progress:p,chase})=>(!input.supplierId||order.supplierId===input.supplierId)
    &&(!input.status||order.status===input.status)&&(!input.progressState||p.progressState===input.progressState)
    &&(!input.risk||(input.risk==="attention" ? p.attention||chase?.deliveryPressure : input.risk==="stale" ? p.daysWithoutUpdate!==null&&p.daysWithoutUpdate>=2 : chase?.deliveryPressure&&chase.dueThisWeek))
    &&(!q||[order.supplierName,...order.lines.map(l=>l.styleNo)].some(s=>s.toLocaleLowerCase().includes(q))));
  filtered.sort((a,b)=>productionProgressRank(a.progress.progressState)-productionProgressRank(b.progress.progressState)
    ||(a.order.deliveryDate??"9999").localeCompare(b.order.deliveryDate??"9999")||a.order.productionOrderId.localeCompare(b.order.productionOrderId));
  const page=input.page??1;
  return {filtered,items:filtered.slice((page-1)*15,page*15),page,pageSize:15 as const,totalCount:filtered.length,
    chaseCounts:{attention:filtered.filter(i=>i.progress.attention||i.chase?.deliveryPressure).length,
      stale:filtered.filter(i=>i.progress.daysWithoutUpdate!==null&&i.progress.daysWithoutUpdate>=2).length,
      duePressure:filtered.filter(i=>i.chase?.deliveryPressure&&i.chase.dueThisWeek).length},
    counts:{inProduction:filtered.filter(i=>i.order.status==="in_production").length,completed:filtered.filter(i=>i.order.status==="production_completed").length,
      shipped:filtered.filter(i=>i.order.status==="shipped").length,attention:filtered.filter(i=>i.progress.attention).length}};
}
export async function readProductionProgressFacts(client:PoolClient,ids:string[],asOf:string) {
    const result=await client.query<FactsRow>(`SELECT production.production_order_id AS id,production.quantity,
      sourcing_effective_delivery_date(production.sourcing_case_id,production.delivery_date,$2::timestamptz)::text AS due,transition.status,
      CASE WHEN transition.status='in_production' THEN COALESCE(reports.quantity,0) ELSE snapshot.completed_quantity END AS completed_quantity,
      CASE WHEN transition.status='in_production' THEN reports.first_on ELSE snapshot.first_reported_on END::text AS first_on,
      CASE WHEN transition.status='in_production' THEN reports.last_at ELSE snapshot.last_updated_at END AS last_at,
      snapshot.business_date::text AS completed_on
      FROM sourcing_production_orders production
      JOIN LATERAL (SELECT sourcing_factory_order_status(production.production_order_id,$2) AS status) transition ON true
      LEFT JOIN LATERAL(SELECT sum(frozen.completed_quantity)::integer AS completed_quantity,min(frozen.first_reported_on) AS first_reported_on,max(frozen.last_updated_at) AS last_updated_at,max(completed.business_date) AS business_date
       FROM sourcing_production_progress_snapshots frozen JOIN sourcing_production_transitions completed ON completed.production_transition_id=frozen.production_transition_id
       WHERE frozen.production_order_id=production.production_order_id AND completed.created_at<=$2) snapshot ON true
      LEFT JOIN LATERAL (SELECT COALESCE(sum(quantity),0)::integer AS quantity,min(business_date) FILTER(WHERE quantity>0) AS first_on,max(created_at) AS last_at
        FROM (SELECT DISTINCT ON(root_report_id) quantity,business_date,created_at FROM sourcing_production_reports
          WHERE production_order_id=production.production_order_id AND created_at<=$2 ORDER BY root_report_id,revision DESC) effective) reports ON true
      WHERE production.production_order_id=ANY($1::uuid[]) AND ${productionNotExcluded}`,[ids,asOf]);
    return new Map(result.rows.map(row=>[row.id,progress(row,asOf)]));
  }

const executionKey=(id:string,factory:string|null|undefined)=>factory?`${id}:${factory}`:id;
export async function readFactoryProductionProgressFacts(client:PoolClient,ids:string[],asOf:string) {
 const result=await client.query<FactsRow&{factory_decision_id:string|null}>(`SELECT production.production_order_id AS id,production.factory_decision_id,
  (SELECT COALESCE(sum(quantity),0)::integer FROM sourcing_factory_execution_lines(production.production_order_id,production.sourcing_decision_id,$2)) AS quantity,
  sourcing_factory_delivery_date(production.sourcing_decision_id,approval.delivery_date,$2)::text AS due,transition.status,
  CASE WHEN transition.status='in_production' THEN COALESCE(reports.quantity,0) ELSE snapshot.completed_quantity END AS completed_quantity,
  CASE WHEN transition.status='in_production' THEN reports.first_on ELSE snapshot.first_reported_on END::text AS first_on,
  CASE WHEN transition.status='in_production' THEN reports.last_at ELSE snapshot.last_updated_at END AS last_at,completed.business_date::text AS completed_on
  FROM sourcing_production_factory_orders production JOIN sourcing_approval_snapshots approval USING(sourcing_approval_snapshot_id)
  JOIN LATERAL (SELECT status FROM sourcing_production_transitions t WHERE t.production_order_id=production.production_order_id AND t.factory_decision_id IS NOT DISTINCT FROM production.factory_decision_id AND t.created_at<=$2 ORDER BY sequence DESC LIMIT 1) transition ON true
  LEFT JOIN sourcing_production_progress_snapshots snapshot ON snapshot.production_order_id=production.production_order_id AND snapshot.factory_decision_id IS NOT DISTINCT FROM production.factory_decision_id
  LEFT JOIN sourcing_production_transitions completed ON completed.production_transition_id=snapshot.production_transition_id
  LEFT JOIN LATERAL (SELECT COALESCE(sum(quantity),0)::integer AS quantity,min(business_date) FILTER(WHERE quantity>0) AS first_on,max(created_at) AS last_at
   FROM (SELECT DISTINCT ON(root_report_id) quantity,business_date,created_at FROM sourcing_production_reports report WHERE report.production_order_id=production.production_order_id
    AND report.factory_decision_id IS NOT DISTINCT FROM production.factory_decision_id AND report.created_at<=$2 ORDER BY root_report_id,revision DESC) effective) reports ON true
  WHERE production.production_order_id=ANY($1::uuid[]) AND ${productionNotExcluded}`,[ids,asOf]);
 return new Map(result.rows.map(row=>[executionKey(row.id,row.factory_decision_id),progress(row,asOf)]));
}

export class ProductionDashboardService {
  constructor(private readonly database:Pool,private readonly reporting:ProductionReportingService,private readonly clock?:()=>Date) {}
  private authorize(actor:TrustedActorContext) {
    if(!canReadProductionReporting(actor))throw new ApplicationError("FORBIDDEN","无权查看实时生产看板",403);
  }
  private async read<T>(actor:TrustedActorContext,work:(client:PoolClient,asOf:string)=>Promise<T>) {
    this.authorize(actor);const client=await this.database.connect();
    try{await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const timestamp=await client.query<{as_of:Date}>("SELECT clock_timestamp() AS as_of");
      const result=await work(client,(this.clock?.()??timestamp.rows[0]!.as_of).toISOString());
      await client.query("COMMIT");return result;
    }catch(error){await client.query("ROLLBACK").catch(()=>undefined);throw error;}finally{client.release();}
  }
  async analysis(actor:TrustedActorContext,input:unknown) {
    return this.read(actor,async(client,asOf)=>{
      const parsed=ProductionAnalysisQuerySchema.safeParse(input);
      if(!parsed.success)throw new ApplicationError("VALIDATION_ERROR","生产分析筛选无效",400);
      const rows=await client.query<ProductionRow>(`${selectProduction} WHERE ${productionVisibility}`,productionVisibilityArgs(actor));
      return readProductionAnalysis(client,rows.rows.map(toOrder),actor,asOf,parsed.data);
    });
  }
  async list(actor:TrustedActorContext,input:ProductionDashboardQuery={}) {
    const parsed=ProductionDashboardQuerySchema.safeParse(input);
    if(!parsed.success)throw new ApplicationError("VALIDATION_ERROR","看板筛选信息无效",400);
    input=parsed.data;
    return this.read(actor,async(client,asOf)=>{
      if(input.previousAsOf&&input.previousAsOf>asOf)throw new ApplicationError("VALIDATION_ERROR","上次刷新时间不能晚于当前时间",400);
      const result=await client.query<ProductionRow>(`${selectFactoryProduction} WHERE ${factoryProductionVisibility}`,productionVisibilityArgs(actor));
      const orders=result.rows.map(toOrder),ids=orders.map(o=>o.productionOrderId);
      const current=await readFactoryProductionProgressFacts(client,ids,asOf);
      const items=addProductionChase(orders.filter(o=>current.has(executionKey(o.productionOrderId,o.factoryDecisionId))).map(order=>({order,progress:current.get(executionKey(order.productionOrderId,order.factoryDecisionId))!})),await readProductionDays(client,ids,asOf,true),asOf);
      const selected=selectDashboardPage(items,input),selectedIds=selected.filtered.map(i=>i.order.productionOrderId);
      const suppliers=[...new Map(orders.map(o=>[o.supplierId,{supplierId:o.supplierId,supplierName:o.supplierName}])).values()]
        .sort((a,b)=>a.supplierName.localeCompare(b.supplierName));
      const events=await this.events(client,selected.filtered.map(item=>item.order));
      if(input.previousAsOf){
        const previous=await readFactoryProductionProgressFacts(client,selectedIds,input.previousAsOf);
        for(const item of selected.filtered){const before=previous.get(executionKey(item.order.productionOrderId,item.order.factoryDecisionId)),after=item.progress;
          // This is an observed refresh change, not a fabricated historical event time.
          if(before&&item.order.status==="in_production"&&before.progressState!==after.progressState&&(before.attention||after.attention))events.push({
            id:`progress:${executionKey(item.order.productionOrderId,item.order.factoryDecisionId)}:${asOf}`,productionOrderId:item.order.productionOrderId,factoryDecisionId:item.order.factoryDecisionId??null,firstStyleNo:item.order.firstStyleNo,supplierName:item.order.supplierName,
            kind:"progress_changed",businessDate:shanghaiDay(asOf),recordedAt:asOf,quantity:after.completedQuantity,
            previousState:before.progressState,progressState:after.progressState,daysWithoutUpdate:after.daysWithoutUpdate});
        }
      }
      events.sort((a,b)=>b.recordedAt.localeCompare(a.recordedAt)||a.id.localeCompare(b.id));
      return ProductionDashboardSchema.parse({asOf,items:selected.items,page:selected.page,pageSize:15,totalCount:selected.totalCount,
        counts:selected.counts,chaseCounts:selected.chaseCounts,suppliers,events:events.slice(0,20)});
    });
  }
  async detail(actor:TrustedActorContext,id:string,factoryDecisionId:string|null=null) {
    return this.read(actor,async(client,asOf)=>{
      const detail=await this.reporting.detail(actor,id,client,factoryDecisionId);
      const facts=await readFactoryProductionProgressFacts(client,[id],asOf);
      return ProductionDashboardDetailSchema.parse({asOf,detail,progress:facts.get(executionKey(id,factoryDecisionId))});
    });
  }
  private async events(client:PoolClient,orders:Pick<ProductionDashboardItem["order"],"productionOrderId"|"factoryDecisionId">[]):Promise<ProductionDashboardEvent[]> {
    const ids=orders.map(order=>order.productionOrderId),factories=orders.map(order=>order.factoryDecisionId??null);
    const result=await client.query<{id:string;production_order_id:string;first_style_no:string;supplier_name_snapshot:string;kind:"report"|"correct"|"complete"|"ship";business_date:string;created_at:Date;quantity:number|null;factory_decision_id:string|null}>(`
      SELECT activity.*,sourcing_current_first_style(production.sourcing_case_id) AS first_style_no,production.supplier_name_snapshot FROM (
        SELECT report.report_id::text AS id,report.production_order_id,report.factory_decision_id,CASE WHEN revision=1 THEN 'report' ELSE 'correct' END AS kind,
          business_date::text,created_at,quantity FROM sourcing_production_reports report WHERE production_order_id=ANY($1::uuid[])
        UNION ALL
        SELECT transition.production_transition_id::text,transition.production_order_id,transition.factory_decision_id,CASE WHEN status='production_completed' THEN 'complete' ELSE 'ship' END,
          business_date::text,transition.created_at,COALESCE((event.after_state->>'recordedQuantity')::integer,snapshot.completed_quantity)
        FROM sourcing_production_transitions transition JOIN operation_events event ON event.event_id=transition.operation_event_id
        LEFT JOIN sourcing_production_progress_snapshots snapshot ON snapshot.production_order_id=transition.production_order_id AND snapshot.factory_decision_id IS NOT DISTINCT FROM transition.factory_decision_id
        WHERE transition.production_order_id=ANY($1::uuid[]) AND status<>'in_production'
      ) activity JOIN unnest($1::uuid[],$2::uuid[]) selected(production_order_id,factory_decision_id)
        ON selected.production_order_id=activity.production_order_id AND selected.factory_decision_id IS NOT DISTINCT FROM activity.factory_decision_id
      JOIN sourcing_production_factory_orders production ON production.production_order_id=activity.production_order_id AND production.factory_decision_id IS NOT DISTINCT FROM activity.factory_decision_id ORDER BY activity.created_at DESC,activity.id LIMIT 20`,[ids,factories]);
    return result.rows.map(r=>({id:r.id,productionOrderId:r.production_order_id,factoryDecisionId:r.factory_decision_id,firstStyleNo:r.first_style_no,supplierName:r.supplier_name_snapshot,
      kind:r.kind,businessDate:r.business_date,recordedAt:iso(r.created_at),quantity:r.quantity,previousState:null,progressState:null,daysWithoutUpdate:null}));
  }
}
