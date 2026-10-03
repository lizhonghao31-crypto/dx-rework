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
import { selectProduction, toOrder, type ProductionRow } from "./sourcing-production-service.js";
import { type ProductionReportingService, canReadProductionReporting, productionVisibility, productionVisibilityArgs } from "./production-reporting-service.js";

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
      completed.business_date::text AS completed_on
      FROM sourcing_production_orders production
      JOIN LATERAL (SELECT status FROM sourcing_production_transitions WHERE production_order_id=production.production_order_id
        AND created_at<=$2 ORDER BY sequence DESC LIMIT 1) transition ON true
      LEFT JOIN sourcing_production_progress_snapshots snapshot USING(production_order_id)
      LEFT JOIN sourcing_production_transitions completed ON completed.production_transition_id=snapshot.production_transition_id
      LEFT JOIN LATERAL (SELECT COALESCE(sum(quantity),0)::integer AS quantity,min(business_date) FILTER(WHERE quantity>0) AS first_on,max(created_at) AS last_at
        FROM (SELECT DISTINCT ON(root_report_id) quantity,business_date,created_at FROM sourcing_production_reports
          WHERE production_order_id=production.production_order_id AND created_at<=$2 ORDER BY root_report_id,revision DESC) effective) reports ON true
      WHERE production.production_order_id=ANY($1::uuid[]) AND ${productionNotExcluded}`,[ids,asOf]);
    return new Map(result.rows.map(row=>[row.id,progress(row,asOf)]));
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
      const result=await client.query<ProductionRow>(`${selectProduction} WHERE ${productionVisibility}`,productionVisibilityArgs(actor));
      const orders=result.rows.map(toOrder),ids=orders.map(o=>o.productionOrderId);
      const current=await readProductionProgressFacts(client,ids,asOf);
      const items=addProductionChase(orders.filter(o=>current.has(o.productionOrderId)).map(order=>({order,progress:current.get(order.productionOrderId)!})),await readProductionDays(client,ids,asOf),asOf);
      const selected=selectDashboardPage(items,input),selectedIds=selected.filtered.map(i=>i.order.productionOrderId);
      const suppliers=[...new Map(orders.map(o=>[o.supplierId,{supplierId:o.supplierId,supplierName:o.supplierName}])).values()]
        .sort((a,b)=>a.supplierName.localeCompare(b.supplierName));
      const events=await this.events(client,selectedIds);
      if(input.previousAsOf){
        const previous=await readProductionProgressFacts(client,selectedIds,input.previousAsOf);
        for(const item of selected.filtered){const before=previous.get(item.order.productionOrderId),after=item.progress;
          // This is an observed refresh change, not a fabricated historical event time.
          if(before&&item.order.status==="in_production"&&before.progressState!==after.progressState&&(before.attention||after.attention))events.push({
            id:`progress:${item.order.productionOrderId}:${asOf}`,productionOrderId:item.order.productionOrderId,firstStyleNo:item.order.firstStyleNo,supplierName:item.order.supplierName,
            kind:"progress_changed",businessDate:shanghaiDay(asOf),recordedAt:asOf,quantity:after.completedQuantity,
            previousState:before.progressState,progressState:after.progressState,daysWithoutUpdate:after.daysWithoutUpdate});
        }
      }
      events.sort((a,b)=>b.recordedAt.localeCompare(a.recordedAt)||a.id.localeCompare(b.id));
      return ProductionDashboardSchema.parse({asOf,items:selected.items,page:selected.page,pageSize:15,totalCount:selected.totalCount,
        counts:selected.counts,chaseCounts:selected.chaseCounts,suppliers,events:events.slice(0,20)});
    });
  }
  async detail(actor:TrustedActorContext,id:string) {
    return this.read(actor,async(client,asOf)=>{
      const detail=await this.reporting.detail(actor,id,client);
      const facts=await readProductionProgressFacts(client,[id],asOf);
      return ProductionDashboardDetailSchema.parse({asOf,detail,progress:facts.get(id)});
    });
  }
  private async events(client:PoolClient,ids:string[]):Promise<ProductionDashboardEvent[]> {
    const result=await client.query<{id:string;production_order_id:string;first_style_no:string;supplier_name_snapshot:string;kind:"report"|"correct"|"complete"|"ship";business_date:string;created_at:Date;quantity:number|null}>(`
      SELECT activity.*,sourcing_current_first_style(production.sourcing_case_id) AS first_style_no,production.supplier_name_snapshot FROM (
        SELECT report.report_id::text AS id,report.production_order_id,CASE WHEN revision=1 THEN 'report' ELSE 'correct' END AS kind,
          business_date::text,created_at,quantity FROM sourcing_production_reports report WHERE production_order_id=ANY($1::uuid[])
        UNION ALL
        SELECT transition.production_transition_id::text,transition.production_order_id,CASE WHEN status='production_completed' THEN 'complete' ELSE 'ship' END,
          business_date::text,transition.created_at,COALESCE((event.after_state->>'recordedQuantity')::integer,snapshot.completed_quantity)
        FROM sourcing_production_transitions transition JOIN operation_events event ON event.event_id=transition.operation_event_id
        LEFT JOIN sourcing_production_progress_snapshots snapshot USING(production_order_id)
        WHERE transition.production_order_id=ANY($1::uuid[]) AND status<>'in_production'
      ) activity JOIN sourcing_production_orders production USING(production_order_id) ORDER BY activity.created_at DESC,activity.id LIMIT 20`,[ids]);
    return result.rows.map(r=>({id:r.id,productionOrderId:r.production_order_id,firstStyleNo:r.first_style_no,supplierName:r.supplier_name_snapshot,
      kind:r.kind,businessDate:r.business_date,recordedAt:iso(r.created_at),quantity:r.quantity,previousState:null,progressState:null,daysWithoutUpdate:null}));
  }
}
