import {slaApplications,appliedSlaWindow} from './sla-applied-window.js';
import {externalPatternRecords} from "./development-external-pattern-facts.js";
import type {PoolClient} from "pg";
import {validateDigitalSlaSnapshot} from "@dx-rework/contracts/digital-sla";
import {developmentSlaPlan} from "./development-sla-enrollment.js";
import {developmentDocumentRow} from "./development-round-repository.js";

type DB=Pick<PoolClient,"query">;
type Task={task_id:string;source_id:string|null;task_kind:string;route_version:number};
export type DevelopmentTiming={sourceId:string;sourceRevision:number;configurationId:string;parameterKey:string;
  enteredAt:string|null;seconds:number|null;warningRatio:number;basis:string[]};
const iso=(value:string|Date)=>new Date(value).toISOString();

/** Responsibility starts at the business boundary, even while assignment or the next action waits. */
export async function developmentTaskTiming(db:DB,task:Task):Promise<DevelopmentTiming|null>{
  if(!task.source_id)return null;
  const saved=await developmentSlaPlan(db,task.source_id);
  if(!saved?.route_nodes.length)return null;
  const document=await developmentDocumentRow(db,task.source_id,task.route_version);
  if(!document)return null;
  let snapshot=validateDigitalSlaSnapshot({ruleVersion:saved.rule_version,parameters:saved.parameters_json});
  const kind=task.task_kind;
  const parameterKey=kind==='development_external_pattern'?'external_pattern':kind==='development_material_recheck'?'development_materials':kind==='development_craft_confirmation'?'development_craft_return':kind;
  const orders=(await db.query('SELECT production_order_id FROM digital_production_orders WHERE source_id=$1',[task.source_id])).rows;
  if(orders.length===1)snapshot=appliedSlaWindow(snapshot,parameterKey,`task:${task.task_id}`,await slaApplications(db,orders[0].production_order_id)).snapshot;
  const parameter=snapshot.parameters[parameterKey]?.value;
  if(!parameter)return null;
  const warning=snapshot.parameters.warning_ratio!.value;
  if(warning.kind!=='ratio')throw new Error('Invalid development warning standard');
  let seconds=parameter.kind==='duration'||parameter.kind==='included'?parameter.minutes*60:null;
  const inherited:Record<string,{taskId:string}>=document.revision?.inherited??{};
  const rows=(await db.query(`SELECT t.task_id,t.route_version,t.completed_at,a.task_kind FROM digital_production_tasks t
    JOIN digital_production_task_access a USING(task_id)
    WHERE a.source_id=$1 AND t.state='completed' AND t.completed_at IS NOT NULL
      AND t.completed_quality IN ('现场登记','已核实')
      AND (t.route_version=$2 OR t.task_id=ANY($3::uuid[]))
      AND NOT EXISTS(SELECT 1 FROM digital_production_task_events e WHERE e.task_id=t.task_id AND e.event_kind='material_returned')
    ORDER BY t.completed_at,t.task_id`,[task.source_id,task.route_version,Object.values(inherited).map(f=>f.taskId)])).rows;
  const published=task.route_version===1?saved.plan_json.anchors.development_published?.value:document.published_at;
  const basis:string[]=[];
  const completed=(...kinds:string[]):string|null=>{
    const row=rows.find(r=>kinds.includes(r.task_kind)&&(r.route_version===task.route_version||kinds.some(k=>inherited[k]?.taskId===r.task_id)));
    if(!row)return null;
    basis.push(`task:${row.task_id}:completed`);
    // Reused work may enable a new correction round, but cannot start its window before that round was published.
    if(row.route_version!==task.route_version&&published){basis.push(`development-round:${task.source_id}:${task.route_version}:published`);return new Date(Math.max(Date.parse(iso(row.completed_at)),Date.parse(iso(published)))).toISOString();}
    return iso(row.completed_at);
  };
  const hasCraft=document.document.craft!=='无';
  const craft=hasCraft?(document.document.craft==='印花'?'development_printing':document.document.craft==='绣花'?'development_embroidery':'development_print_embroidery'):null;
  let enteredAt:string|null=null;
  if(kind==='development_external_pattern'){
    const request=(await externalPatternRecords(db,task.source_id)).find(r=>r.taskId===task.task_id);
    if(request){enteredAt=iso(request.requestedAt);basis.push(`external-pattern:${request.requestId}:requested`);}
  }else if(kind==='development_materials'||kind==='development_material_recheck'){
    enteredAt=published?iso(published):null;basis.push(`development:${task.source_id}:round:${task.route_version}:published`);
  }else if(kind==='development_pattern')enteredAt=completed('development_materials','development_material_recheck');
  else if(kind==='development_cutting')enteredAt=completed('development_pattern');
  else if(kind==='development_craft_dispatch'||kind===craft)enteredAt=completed('development_cutting');
  else if(kind==='development_craft_confirmation'){
    const start=completed('development_cutting'),parent=craft?snapshot.parameters[craft]?.value:undefined;
    if(start&&parent?.kind==='duration'&&seconds!==null)enteredAt=new Date(Date.parse(start)+parent.minutes*60000-seconds*1000).toISOString();
  }else if(kind==='development_sewing'||kind==='development_sewing_transfer')enteredAt=hasCraft?completed('development_craft_confirmation'):completed('development_cutting');
  else if(kind==='development_pre_wash_check')enteredAt=completed('development_sewing');
  else if(kind==='development_washing'||kind==='development_washing_dispatch')enteredAt=completed('development_pre_wash_check');
  else if(kind==='development_tail_check')enteredAt=document.document.washing==='免洗'?completed('development_sewing'):completed('development_washing');
  else seconds=null;
  return {sourceId:task.source_id,sourceRevision:saved.revision,configurationId:saved.configuration_id,parameterKey,enteredAt,seconds,warningRatio:warning.percent/100,basis};
}
