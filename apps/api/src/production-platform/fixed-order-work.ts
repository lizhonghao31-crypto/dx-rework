import type {SeriesRoute} from '@dx-rework/contracts/digital-series-plan';
import type {SlaAnchor} from '@dx-rework/domain/digital-sla-plan';
import type {CraftStepChoice} from '@dx-rework/contracts/digital-craft';
import type {FixedTimelineInput} from './fixed-timeline-adoptions.js';
import {frozenWorkDefinition,frozenCraftDefinition,frozenCraftChoice,craftParameterKey,withOrderTimeStageReserves,type FixedWorkInputs} from './fixed-work-definition.js';
import {orderTimeRule} from '@dx-rework/contracts/order-time-plan';
import type {BulkWashingArrangement} from '@dx-rework/contracts/bulk-washing';
import {bulkWashingWork} from './bulk-washing-work.js';
type Work=FixedTimelineInput['work'][number];
export type FixedOrderPlanningLine={line_id:string;goal:SlaAnchor|undefined;customerDateVersion:number;washing?:BulkWashingArrangement};
/** The native capture and the read-only calculator share this exact DAG. */
export function fixedOrderWork(initial:FixedWorkInputs,orderId:string,sourceId:string,sourceRound:number,preshrink:string,craftSteps:Array<CraftStepChoice&{stepId:string}>,dual:boolean,source:Pick<FixedTimelineInput,'work'|'route'>|null,lines:FixedOrderPlanningLine[],frameworkRoute?:SeriesRoute,materialHandover?:{preorder:boolean;keepLegacyGraph?:boolean}){
  const work:Work[]=[],route:NonNullable<FixedTimelineInput['route']>=[];
  const add=(id:string,parameterKey:string,dependsOn:string[]=[],options:Partial<Work>={})=>{
   const policy=frozenWorkDefinition(initial,parameterKey,dual&&['bulk_embroidery','bulk_printing'].includes(parameterKey));
   const node:Work={id,parameterKey,dependsOn,...policy,
    canonicalWorkRef:`order:${orderId}:work:${id}`,accountingRole:'original_work',...options};
   work.push(node);return node;
  };
  const framework=initial.data.orderTimePlan?.company.framework;
  if(framework&&!frameworkRoute)throw Error('请在原单确认是否需要对色');
  let sourceEnd:string|null=null;
  if(source){
   const used=source.work.filter(node=>node.id!=='development_shipping');
   for(const node of used)work.push({...structuredClone(node),id:`source:${node.id}`,dependsOn:node.dependsOn.map(id=>`source:${id}`),
    ...(node.includedIn?{includedIn:`source:${node.includedIn}`}:{ }),accountingRole:'shared_reference'});
   const end=source.route?.at(-1)?.nodeId;if(end)sourceEnd=`source:${end}`;
  }else if(!initial.data.orderTimePlan){
   // A legacy source is a reference to its own original scope, never a newly
   // performed copy or a reset employee clock. Its missing original B stays so.
   add('source_confirmation','source_confirmation',[],{minutes:0,calendar:null,planningParameterRef:null,responsibilitySlaRef:null,
    canonicalWorkRef:`source:${sourceId}:round:${sourceRound}:confirmation`,accountingRole:'shared_reference'});sourceEnd='source_confirmation';
  }
  if(framework){
   add('design_handover','design_handover',[],{stage:1,accountingRole:'event'});
   const pattern=work.find(node=>['development_pattern','external_pattern','development_external_pattern'].includes(node.parameterKey??''));
   add('material_investment','material_investment',['design_handover',...(pattern&&!materialHandover?.preorder?[pattern.id]:[])],{stage:3,accountingRole:'event'});
   add('fabric_receipt',frameworkRoute==='A'?'fabric_receipt_a':'fabric_receipt_b',['material_investment'],{stage:3});
   if(frameworkRoute==='A')add('color_confirmation','color_confirmation',materialHandover?.keepLegacyGraph?['fabric_receipt']:[],{stage:3});
   add('client_sample_approval','client_sample_approval',sourceEnd?[sourceEnd]:[],{stage:2,accountingRole:'event'});
   add('development_size_review','development_size_review',['client_sample_approval'],{stage:2});
   add('style_label_ready','style_label_ready',[],{stage:3,accountingRole:'event'});
  }
  // A new direct formal order has no independent development route. Do not
  // invent a legacy confirmation node and make every real successor unknown.
  add('customer_confirmation','customer_confirmation',[],{minutes:0,calendar:null,accountingRole:'event'});
  add('budget','budget',['customer_confirmation']);
  add('production_sheet','production_sheet',['customer_confirmation',...(framework?['development_size_review','fabric_inspection']:sourceEnd?[sourceEnd]:[])]);
  add('bulk_pattern','bulk_pattern',['production_sheet']);
  add('sourcing_ie','sourcing_ie',['budget']);add('sourcing_selection','sourcing_selection',['sourcing_ie']);add('sourcing_approval','sourcing_approval',['sourcing_selection']);
  add('fabric_inspection','fabric_inspection',framework?['fabric_receipt']:[]);
  if(preshrink==='需要预缩')add('warehouse_preshrink','warehouse_preshrink',['fabric_inspection']);
  add('bulk_cutting','bulk_cutting',['bulk_pattern',preshrink==='需要预缩'?'warehouse_preshrink':'fabric_inspection','sourcing_approval',...(framework?['style_label_ready']:[])]);
  let previous='bulk_cutting';
  for(const step of craftSteps){
   const key=craftParameterKey(step,'bulk'),node=add(initial.data.orderTimePlan?`${key}:${step.stepId}`:key,key,[previous],{...frozenCraftDefinition(initial,step,'bulk',dual),...(step.craftKind==='special'?{stage:5,craftStep:frozenCraftChoice(step)}:{}),...(initial.data.orderTimePlan?{canonicalWorkRef:`order:${orderId}:step:${step.stepId}:work`}:{})});
   const qc=add(`bulk_qc:${step.stepId}`,'bulk_qc',[node.id],initial.data.orderTimePlan?{canonicalWorkRef:`order:${orderId}:step:${step.stepId}:qc`}:{});previous=qc.id;
   route.push({kind:'process_logistics',position:route.length,nodeId:node.id,stepId:step.stepId,phase:'logistics'});
   route.push({kind:'bulk_qc',position:route.length,nodeId:qc.id,stepId:step.stepId,phase:'qc'});
  }
  add('warehouse_accessories','warehouse_accessories',framework&&frameworkRoute==='A'&&materialHandover?.keepLegacyGraph?['color_confirmation']:[]);
  add('warehouse_dispatch','warehouse_dispatch',[previous,'sourcing_approval','warehouse_accessories']);
  route.push({kind:'warehouse_dispatch',position:route.length,nodeId:'warehouse_dispatch'});
  const common=work.map(node=>node.id);
  const consumers:FixedTimelineInput['consumers']=[];
  for(const line of lines){
   const suffix=`:${line.line_id}`,goal=line.goal;
   const factory=add(`factory_work${suffix}`,'factory_production_work',['warehouse_dispatch']);
   const washing=bulkWashingWork(orderId,line.line_id,line.washing,factory,`garment_inspection${suffix}`);
   Object.assign(factory,washing.factory);work.push(...washing.work);
   add(`factory_production${suffix}`,'factory_production',[washing.factoryEnd]);
   add(`return_logistics${suffix}`,'return_logistics',[`factory_production${suffix}`]);
   add(`garment_inspection${suffix}`,'garment_inspection',[`return_logistics${suffix}`]);
   add(`garment_packing${suffix}`,'garment_packing',[washing.packingPredecessor]);
   add(`ship_sample${suffix}`,'ship_sample');
   const nodeIds=[...common,...work.filter(node=>node.id.endsWith(suffix)).map(node=>node.id)];
   const advance=initial.data.orderTimePlan?orderTimeRule(initial.data.orderTimePlan,'ship_sample_advance')?.rule:initial.data.unified.values.parameters.ship_sample_advance?.value;
   consumers.push({scopeRef:`po:${line.line_id}`,lineId:line.line_id,nodeIds,customerDateVersion:line.customerDateVersion,customerGoalIds:[`garment_packing${suffix}`],
    shipSample:{nodeId:`ship_sample${suffix}`,productionNodeId:`factory_work${suffix}`,customerGoalId:`garment_packing${suffix}`,advanceDays:advance?.kind==='offset'?advance.days:null},
    ends:{[`garment_packing${suffix}`]:goal??{precision:'unknown',reason:'本PO首次采用时尚无正式客户交期'},[`ship_sample${suffix}`]:{precision:'unknown',reason:'本PO寄船样目标待原冻结生产开始和提前量共同求解'}}});
  }
 return {work:withOrderTimeStageReserves(initial,work),route,consumers};
}
