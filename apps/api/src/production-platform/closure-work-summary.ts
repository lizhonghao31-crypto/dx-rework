import type {Pool,PoolClient} from 'pg';
import type {ClosureWorkSummary} from '@dx-rework/contracts/order-closure';
/** Internal projection: callers must establish original full business-detail access. */
export async function readClosureWorkSummaries(db:Pick<Pool|PoolClient,'query'>,reworks:readonly {rework_order_id:string;rework_kind:string}[]):Promise<ReadonlyMap<string,ClosureWorkSummary>>{
 const summaries=new Map<string,ClosureWorkSummary>(reworks.map(row=>[row.rework_order_id,{
  kind:row.rework_kind==='qc_rework'?'qc_rework':row.rework_kind==='inhouse_finishing'?'inhouse_finishing':'unknown',processes:[],
 }]));
 if(!summaries.size)return summaries;
 const processes=(await db.query(`SELECT configuration.rework_order_id,item.configuration_item_id,item.process_name,item.execution_kind,
    sum(rework_work_report_effective_quantity(report.work_report_id)) AS reported_quantity,
    coalesce(array_agg(report.work_report_id ORDER BY report.work_report_id) FILTER(WHERE report.work_report_id IS NOT NULL),'{}'::uuid[]) AS report_ids
    FROM rework_process_configurations configuration JOIN rework_process_configuration_items item USING(configuration_id)
    LEFT JOIN rework_work_tasks task ON task.configuration_item_id=item.configuration_item_id AND task.rework_order_id=configuration.rework_order_id AND task.status='active'
    LEFT JOIN rework_work_reports report ON report.work_task_id=task.work_task_id AND report.configuration_item_id=item.configuration_item_id AND report.rework_order_id=configuration.rework_order_id AND report.status='submitted'
      AND NOT EXISTS(SELECT 1 FROM rework_work_report_rejections rejection WHERE rejection.work_report_id=report.work_report_id)
    WHERE configuration.rework_order_id=ANY($1::uuid[]) AND configuration.status='approved'
    GROUP BY configuration.rework_order_id,item.configuration_item_id,item.process_name,item.execution_kind
    ORDER BY configuration.rework_order_id,item.configuration_item_id`,[[...summaries.keys()]])).rows;
 for(const row of processes)summaries.get(row.rework_order_id)!.processes.push({
  configurationItemId:row.configuration_item_id,processName:row.process_name,executionKind:row.execution_kind,
  reportedQuantity:row.reported_quantity==null?null:Number(row.reported_quantity),reportIds:row.report_ids,
 });
 return summaries;
}
