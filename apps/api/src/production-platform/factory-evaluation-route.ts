import type {FixedTimelineInput} from './fixed-timeline-adoptions.js';
import type {AdoptedCraftStep} from '@dx-rework/contracts/digital-craft';
import type {SlaPlan,SlaPlanNode} from '@dx-rework/domain/digital-sla-plan';

/** Read-only references to the original frozen route, not a capture command. */
export type FactoryEvaluationRoute={
 adoptionId:string;routeRef:string;sourceRef:string;
 work:FixedTimelineInput['work'];route:NonNullable<FixedTimelineInput['route']>;
 replacedWorkIds:string[];
 groups:Array<{nodeIds:string[];lastNodeId:string;handoffNodeId:string}>;
};
export type FactorySlaInstance={nodeId:string;stepId:string|null;phase:'logistics'|'qc'|'work';taskKind:'process_logistics'|'bulk_qc'|'warehouse_preshrink';routeRef:string;taskIds:string[];lineIds:string[];snapshotId:string};

/** Adapt the captured graph. Node identity is never reconstructed from a kind
 * or parameter: initial and added routes deliberately use different IDs. */
export function factoryFrozenEvaluationPlan(plan:SlaPlan,frozen:FactoryEvaluationRoute,steps:readonly AdoptedCraftStep[]):SlaPlan{
 const copy=structuredClone(plan),positions=frozen.route.filter(row=>row.phase==='logistics'||row.phase==='qc');
 const ids=positions.map(row=>row.nodeId);
 if(new Set(ids).size!==ids.length)throw Error('Duplicate factory route node');
 if(new Set(frozen.work.map(work=>work.id)).size!==frozen.work.length)throw Error('Duplicate frozen factory work');
 const workById=new Map(frozen.work.map(work=>[work.id,work])),routeIds=new Set(ids),replaced=new Set(frozen.replacedWorkIds);
 const placeholders=new Set(['bulk_printing','bulk_embroidery','bulk_print_embroidery','bulk_qc']);
 for(const node of copy.nodes)if((placeholders.has(node.id)||replaced.has(node.id))&&!routeIds.has(node.id)){
  node.applicable='no';node.countsProgress=false;
 }
 const inserted=new Set([...ids,...frozen.groups.flatMap(group=>group.nodeIds)]),aliases=new Map<string,string>();
 for(const id of inserted){
  const work=workById.get(id);if(!work)throw Error('Frozen factory work is missing: '+id);
  const position=positions.find(row=>row.nodeId===id),step=position?steps.find(step=>step.stepId===position.stepId):undefined;
  if(position&&!step)throw Error('Frozen factory step is missing: '+position.stepId);
  const old=copy.nodes.find(node=>node.id===id),template=plan.nodes.find(node=>node.id===id)??(!position?plan.nodes.find(node=>node.parameterKey===work.parameterKey):undefined),minutes=work.responsibilitySlaRef?work.responsibilityMinutes??null:null;
  if(!position&&template&&template.id!==id){
   if(aliases.has(template.id))throw Error('Ambiguous factory native work alias');
   aliases.set(template.id,id);const generic=copy.nodes.find(node=>node.id===template.id)!;generic.applicable='no';generic.countsProgress=false;
  }
  const label=step?(step.craftKind==='special'?step.specialCraft!.definition.name:step.craftKind==='printing'?'印花':step.craftKind==='embroidery'?'绣花':'印绣花')+(position!.phase==='qc'?' · 检查':' · 发收'):old?.label??'预缩';
  const node:SlaPlanNode={id,label,stage:work.stage??template?.stage??5,parameterKey:work.parameterKey??id,applicable:'yes',countsProgress:work.accountingRole!=='shared_reference'&&(template?.countsProgress??true),
   kind:minutes===null?'unlimited':'duration',minutes,offsetDays:null,dependsOn:[...work.dependsOn],anchorKey:work.dependsOn.length?null:'factory_scope_unconfirmed',targetKey:null,includedIn:null,includedPosition:'end'};
  if(old)Object.assign(old,node);else copy.nodes.push(node);
 }
 copy.anchors.factory_scope_unconfirmed={precision:'unknown',reason:'本次新增范围没有独立可信交接时间，不借用旧工艺起点'};
 const dispatch=copy.nodes.find(node=>node.id==='warehouse_dispatch'),originalDispatch=workById.get('warehouse_dispatch');
 if(dispatch&&originalDispatch)dispatch.dependsOn=[...originalDispatch.dependsOn];
 // Added scope declares its own handoff. Keep unrelated original prerequisites
 // and remove only the explicitly replaced route's old factory edges.
 for(const group of frozen.groups){
  const handoff=copy.nodes.find(node=>node.id===group.handoffNodeId);if(!handoff)throw Error('Frozen factory handoff is missing: '+group.handoffNodeId);
  handoff.dependsOn=[...new Set([...handoff.dependsOn.filter(id=>!replaced.has(id)||routeIds.has(id)).map(id=>aliases.get(id)??id),group.lastNodeId])];
 }
 return copy;
}
