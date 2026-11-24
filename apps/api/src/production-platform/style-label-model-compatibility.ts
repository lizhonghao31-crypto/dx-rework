import type {PoolClient} from 'pg';

type Db=Pick<PoolClient,'query'>;
const priorCalculation='journey-facts-material-investment-v19';
const installed=new WeakSet<Db>();

async function canProvePriorSource(db:Db){
 if(installed.has(db))return true;
 const {rows}=await db.query<{available:boolean}>(`SELECT to_regclass('digital_timeline_adoptions') IS NOT NULL
  AND to_regclass('digital_order_time_plan_versions') IS NOT NULL AS available`);
 if(!rows[0]?.available)return false;
 installed.add(db);
 return true;
}

/** Only a current source-only graph can prove that the v19 model never used
 * order-scoped label readiness. All other old models are rebuilt by the existing queue.
 * Arguments are repository-owned SQL column expressions, never request values. */
export async function styleLabelModelVersionSql(db:Db,model:string,current:string,kind:string,id:string){
 // Older schemas can serve the current calculation without parsing SQL for
 // missing tables. Reusing a prior model requires the complete proof below.
 if(!await canProvePriorSource(db))return `(${model} IS NOT DISTINCT FROM ${current})`;
 const labelWork=`'$.work[*] ? (@.parameterKey == "style_label_ready" || @.id like_regex "^style_label_ready(:.*)?$" || @.dependsOn[*] like_regex "^style_label_ready(:.*)?$")'`;
 return `(CASE WHEN ${model}=${current} THEN true
  WHEN ${model} IS DISTINCT FROM '${priorCalculation}' OR ${kind} IS DISTINCT FROM 'source' THEN false
  ELSE EXISTS(SELECT 1 FROM digital_production_sources style_source WHERE style_source.source_id=${id}
   AND NOT EXISTS(SELECT 1 FROM digital_production_orders style_order WHERE style_order.source_id=style_source.source_id)
   AND NOT EXISTS(SELECT 1 FROM digital_production_task_access style_task
    WHERE style_task.source_id=style_source.source_id AND (style_task.production_order_id IS NOT NULL OR style_task.task_kind='style_label_ready'))
   AND NOT EXISTS(SELECT 1 FROM (SELECT route_nodes FROM digital_development_rounds WHERE source_id=style_source.source_id ORDER BY round_number DESC LIMIT 1) style_round
    WHERE 'style_label_ready'=ANY(style_round.route_nodes))
   AND NOT EXISTS(SELECT 1 FROM (SELECT route_nodes FROM digital_development_sla_plans WHERE source_id=style_source.source_id ORDER BY revision DESC LIMIT 1) style_sla
    WHERE 'style_label_ready'=ANY(style_sla.route_nodes))
   AND NOT EXISTS(SELECT 1 FROM (SELECT input_snapshot FROM digital_timeline_adoptions WHERE source_id=style_source.source_id ORDER BY round_number DESC LIMIT 1) style_timeline
    WHERE jsonb_typeof(style_timeline.input_snapshot->'work') IS DISTINCT FROM 'array' OR jsonb_path_exists(style_timeline.input_snapshot,${labelWork}))
   AND NOT EXISTS(SELECT 1 FROM (SELECT input_snapshot FROM digital_order_time_plan_versions WHERE source_id=style_source.source_id ORDER BY revision DESC LIMIT 1) style_plan
    WHERE jsonb_typeof(style_plan.input_snapshot->'work') IS DISTINCT FROM 'array' OR jsonb_path_exists(style_plan.input_snapshot,${labelWork})))
  END)`;
}
