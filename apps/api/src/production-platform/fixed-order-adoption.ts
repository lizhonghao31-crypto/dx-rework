import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import type {BusinessTime} from '@dx-rework/domain/business-clock';
import type {SlaAnchor} from '@dx-rework/domain/digital-sla-plan';
import type {DevelopmentDocument} from '@dx-rework/contracts/digital-development';
import type {InstructionDocument} from '@dx-rework/contracts/production-instruction';
import {CraftStepChoicesSchema} from '@dx-rework/contracts/digital-craft';
import {FixedTimelineAdoptionRepository,type FixedTimelineInput} from './fixed-timeline-adoptions.js';
import {readInitialTimelineInput} from './fixed-timeline-initial-input.js';
import {captureFixedCraftSteps} from './fixed-craft-steps.js';
import {frozenWorkDefinition} from './fixed-work-definition.js';
import {captureFixedOrderRoute} from './fixed-order-route.js';

type Work=FixedTimelineInput['work'][number];
/** Only original authorized native publication/preparation calls this adapter.
 * It freezes identities and planning inputs; the bounded worker computes B.
 */
export async function captureOrderTimeline(db:PoolClient,actorId:string,orderId:string,routeRef:string,instructionVersion:number,document:InstructionDocument,
 sourceId:string,sourceRound:number,sourceDocument:DevelopmentDocument,eventRef:string,time:BusinessTime){
 const resource={kind:'order' as const,id:orderId},initial=await readInitialTimelineInput(db,resource);if(!initial)return null;
 const repo=new FixedTimelineAdoptionRepository(db);
 const saved=await repo.capture(resource,1,actorId,eventRef,time,'fixed_v2',async()=>{
  const original=(await db.query('SELECT plan_id,revision,plan_json FROM digital_sla_plans WHERE production_order_id=$1 ORDER BY revision LIMIT 1',[orderId])).rows[0];
  const inherited=document.secondaryCraft==='沿用开发',label=inherited?sourceDocument.craft:document.secondaryCraft;
  const selected=inherited?sourceDocument.craftSteps:document.craftSteps;
  if(label==='印绣花'&&!selected)throw Error('请在原制单明确绣花、印花的实际先后顺序');
  const choices=label==='无'?[]:CraftStepChoicesSchema.parse(selected??[{craftKind:label==='绣花'?'embroidery':'printing',sequence:1}]);
  const craftSteps=choices.map(step=>({...step,stepId:randomUUID()})),dual=craftSteps.length===2;
  const work:Work[]=[],route:NonNullable<FixedTimelineInput['route']>=[];
  const add=(id:string,parameterKey:string,dependsOn:string[]=[],options:Partial<Work>={})=>{
   const policy=frozenWorkDefinition(initial,parameterKey,dual&&['bulk_embroidery','bulk_printing'].includes(parameterKey));
   const node:Work={id,parameterKey,dependsOn,...policy,
    canonicalWorkRef:`order:${orderId}:work:${id}`,accountingRole:'original_work',...options};
   work.push(node);return node;
  };
  const source=await repo.existing({kind:'source',id:sourceId},sourceRound);
  let sourceEnd:string|null=null;
  if(source){
   const used=source.input.work.filter(node=>node.id!=='development_shipping');
   for(const node of used)work.push({...structuredClone(node),id:`source:${node.id}`,dependsOn:node.dependsOn.map(id=>`source:${id}`),
    ...(node.includedIn?{includedIn:`source:${node.includedIn}`}:{ }),accountingRole:'shared_reference'});
   const end=source.input.route?.at(-1)?.nodeId;if(end)sourceEnd=`source:${end}`;
  }else{
   // A legacy source is a reference to its own original scope, never a newly
   // performed copy or a reset employee clock. Its missing original B stays so.
   add('source_confirmation','source_confirmation',[],{minutes:0,calendar:null,planningParameterRef:null,responsibilitySlaRef:null,
    canonicalWorkRef:`source:${sourceId}:round:${sourceRound}:confirmation`,accountingRole:'shared_reference'});sourceEnd='source_confirmation';
  }
  add('customer_confirmation','customer_confirmation',[],{minutes:0,calendar:null,accountingRole:'event'});
  add('budget','budget',['customer_confirmation']);
  add('production_sheet','production_sheet',['customer_confirmation',...(sourceEnd?[sourceEnd]:[])]);
  add('bulk_pattern','bulk_pattern',['production_sheet']);
  add('sourcing_ie','sourcing_ie',['budget']);add('sourcing_selection','sourcing_selection',['sourcing_ie']);add('sourcing_approval','sourcing_approval',['sourcing_selection']);
  add('fabric_inspection','fabric_inspection');
  if(document.preshrink==='需要预缩')add('warehouse_preshrink','warehouse_preshrink',['fabric_inspection']);
  add('bulk_cutting','bulk_cutting',['bulk_pattern',document.preshrink==='需要预缩'?'warehouse_preshrink':'fabric_inspection','sourcing_approval']);
  let previous='bulk_cutting';
  for(const step of craftSteps){
   const key=`bulk_${step.craftKind}`,node=add(key,key,[previous]);
   const qc=add(`bulk_qc:${step.stepId}`,'bulk_qc',[node.id]);previous=qc.id;
   route.push({kind:'process_logistics',position:route.length,nodeId:node.id,stepId:step.stepId,phase:'logistics'});
   route.push({kind:'bulk_qc',position:route.length,nodeId:qc.id,stepId:step.stepId,phase:'qc'});
  }
  add('warehouse_accessories','warehouse_accessories');
  add('warehouse_dispatch','warehouse_dispatch',[previous,'sourcing_approval','warehouse_accessories']);
  route.push({kind:'warehouse_dispatch',position:route.length,nodeId:'warehouse_dispatch'});
  const common=work.map(node=>node.id);
  const lines=(await db.query('SELECT line_id FROM digital_production_po_lines WHERE production_order_id=$1 ORDER BY position',[orderId])).rows;
  const consumers:FixedTimelineInput['consumers']=[];
  for(const line of lines){
   const suffix=`:${line.line_id}`,goal=original.plan_json.anchors[`customer_shipping_date${suffix}`] as SlaAnchor|undefined;
   const recorded=(await db.query("SELECT version FROM digital_po_date_changes WHERE line_id=$1 AND date_kind='customer' AND source='initial_po' ORDER BY version LIMIT 1",[line.line_id])).rows[0];
   add(`factory_work${suffix}`,'factory_production_work',['warehouse_dispatch']);
   add(`factory_production${suffix}`,'factory_production',[`factory_work${suffix}`]);
   add(`return_logistics${suffix}`,'return_logistics',[`factory_production${suffix}`]);
   add(`garment_inspection${suffix}`,'garment_inspection',[`return_logistics${suffix}`]);
   add(`garment_packing${suffix}`,'garment_packing',[`garment_inspection${suffix}`]);
   add(`ship_sample${suffix}`,'ship_sample');
   const nodeIds=[...common,...work.filter(node=>node.id.endsWith(suffix)).map(node=>node.id)];
   const advance=initial.data.unified.values.parameters.ship_sample_advance?.value;
   consumers.push({scopeRef:`po:${line.line_id}`,lineId:line.line_id,nodeIds,customerDateVersion:recorded?.version??0,customerGoalIds:[`garment_packing${suffix}`],
    shipSample:{nodeId:`ship_sample${suffix}`,productionNodeId:`factory_work${suffix}`,customerGoalId:`garment_packing${suffix}`,advanceDays:advance?.kind==='offset'?advance.days:null},
    ends:{[`garment_packing${suffix}`]:goal??{precision:'unknown',reason:'本PO首次采用时尚无正式客户交期'},[`ship_sample${suffix}`]:{precision:'unknown',reason:'本PO寄船样目标待原冻结生产开始和提前量共同求解'}}});
  }
  return {timelineSchemaVersion:2,routeSchemaVersion:2,calculationVersion:'fixed-backward-v1',resource,round:1,
   originalPlan:{ref:`digital_sla_plans:${original.plan_id}`,revision:original.revision,plan:original.plan_json},
   unified:{snapshotRef:initial.data.unified.snapshotRef,values:initial.data.unified.values},development:initial.data.development,
   sourceVersions:{initialIdentityHash:initial.identityHash,configurationId:initial.data.unified.configurationId,routeRef,instructionVersion,sourceId,sourceRound,preshrink:document.preshrink},work,route,craftSteps,consumers};
 });
 if(saved){
  const scope=await captureFixedOrderRoute(db,saved,routeRef,document,sourceDocument,eventRef,time,actorId);
  await captureFixedCraftSteps(db,saved,resource,routeRef,1,scope?.craftSteps??saved.input.craftSteps??[],actorId,eventRef);
 }
 return saved;
}
