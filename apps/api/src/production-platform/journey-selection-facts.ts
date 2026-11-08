import {validateBusinessTime,type BusinessTime} from '@dx-rework/domain/business-clock';
import {evaluateSlaPlan,slaDateBoundary} from '@dx-rework/domain/digital-sla-plan';
import type {JourneyCoverage,JourneyNode,JourneyState,OrderJourney} from '@dx-rework/contracts/digital-production-journey';
import type {JourneyFactTask} from './journey-fact-model.js';
import type {JourneySelectionNode} from './journey-projection.js';
import type {JourneyTimingInputs} from './journey-supervision.js';
import type {JourneySelectionClockFrame} from './journey-selection-clock.js';

/** Shared native selection facts, never an authorized row or an executable DTO.
 * A reader must still apply live source/order/node and field permissions. */
export type JourneySelectionFacts={
 version:'journey-selection-v1';canonicalId:string;
 nodes:JourneySelectionFactNode[];
 /** Native pre-domain and pre-SLA alternatives for live field/node scopes. */
 nativeNodes:JourneySelectionFactNode[];
 untimedNodes:JourneySelectionFactNode[];
 tasks:Array<Pick<JourneyFactTask,'id'|'kind'|'sourceId'|'orderId'|'assigneeId'|'requiredRole'>>;
 coverage:JourneyCoverage[];
 deliveryRisks:Array<Pick<NonNullable<OrderJourney['deliveryRisks']>[number],'nodeKey'|'risk'|'lineId'>>;
 cancelled:boolean;closedAt:string|null;customerReminderDate:string|null;
 frames?:JourneySelectionClockFrame[];
};
export type JourneySelectionFactNode=JourneySelectionNode&{entered:boolean;recorded:boolean;dateTarget?:string};

const open=(node:JourneySelectionNode)=>!['completed','inherited','cancelled','not_applicable','unavailable'].includes(node.state);
export type JourneySelectionTask=JourneyFactTask&{state:JourneyState};
/** Build once per changed mother, not once per list candidate per request.
 * Labels, PO metadata, people names, URLs, money and authorization conclusions
 * deliberately stay outside this small selector. */
export function journeySelectionFacts(item:OrderJourney,inputs:JourneyTimingInputs,tasks:readonly JourneySelectionTask[],time:BusinessTime,originalNodes?:{native:JourneySelectionFacts['nodes'];untimed:JourneySelectionFacts['nodes']}):{facts:JourneySelectionFacts;expiresAt:string|null}{
 validateBusinessTime(time);
 if(item.asOf!==time.now)throw Error('Journey selector requires the same captured observation time');
 const now=Date.parse(time.now);let nextAt:number|null=null;
 const reconsider=(at:string|null|undefined,strict=false)=>{
  if(!at)return;const value=Date.parse(at);if(!Number.isFinite(value))throw Error('Invalid Journey selection time boundary');
  const next=value+(strict?1:0);if(next>now&&(nextAt===null||next<nextAt))nextAt=next;
 };
 // Original date comparisons change at the beginning of that Beijing date,
 // then at its existing exclusive end; no date-only event becomes an instant.
 const reconsiderDate=(date:string|null|undefined)=>{
  if(!date)return;const end=slaDateBoundary(date).at!;
  reconsider(new Date(Date.parse(end)-86400000).toISOString());reconsider(end);
 };
 if(inputs.plan)evaluateSlaPlan(inputs.plan,inputs.facts,time,{mode:'read_projection',onNextChange:reconsider});
 const current=item.stages.flatMap(stage=>stage.nodes).filter(node=>node.current),byTask=new Map(tasks.map(task=>[task.id,task]));
 for(const node of current){
  const task=byTask.get(node.instanceId);
  // Use the original task state before presentation substitutes e.g. a linked
  // procurement record. The native still-open task must not lose its boundary.
  if(task&&['active','blocked'].includes(task.state)){
   reconsider(task.dueAt,task.deadlineExclusive===false);reconsider(task.warningAt);
  }
  if(!open(node))continue;
  if(node.expectedPrecision==='date'&&/^\d{4}-\d{2}-\d{2}$/.test(node.expectedAt??''))reconsiderDate(node.expectedAt);
 }
 const terminal=item.display?.mainState==='completed'||item.display?.mainState==='cancelled';
 if(!terminal){
  for(const line of item.poDeliveryDates??[]){reconsiderDate(line.customerWarehouseArrivalDate);reconsiderDate(line.factoryDeliveryDate);reconsiderDate(line.sampleTargetDate);}
  reconsiderDate(item.supervision?.customerReminderDate);
 }
 const ids=new Set(current.map(node=>node.instanceId));
 const facts:JourneySelectionFacts={version:'journey-selection-v1',canonicalId:item.id,
  nodes:journeySelectionNodes(current),
  nativeNodes:structuredClone(originalNodes?.native??journeySelectionNodes(current)),untimedNodes:structuredClone(originalNodes?.untimed??journeySelectionNodes(current)),
  tasks:tasks.filter(task=>ids.has(task.id)).map(task=>({id:task.id,kind:task.kind,sourceId:task.sourceId,orderId:task.orderId,assigneeId:task.assigneeId,requiredRole:task.requiredRole})),
  coverage:(item.supervision?.coverage??[]).map(value=>({key:value.key,message:value.message})),
  deliveryRisks:(item.deliveryRisks??[]).map(value=>({nodeKey:value.nodeKey,risk:value.risk,lineId:value.lineId})),
  cancelled:item.display?.mainState==='cancelled',closedAt:item.display?.closedAt??null,customerReminderDate:item.supervision?.customerReminderDate??null};
 return {facts,expiresAt:nextAt!==null?new Date(nextAt).toISOString():null};
}

/** Capture only the same minimal node data before domain facts/field-specific
 * presentation replace it. These are native alternatives, not cached grants. */
export function journeySelectionNodes(nodes:readonly JourneyNode[]):JourneySelectionFacts['nodes']{
 return nodes.filter(node=>node.current).map(node=>({key:node.key,instanceId:node.instanceId,stage:node.stage,state:node.state,current:true,
  ...(node.planningOnly===undefined?{}:{planningOnly:node.planningOnly}),risks:[...node.risks],entered:Boolean(node.enteredAt),recorded:node.records.length>0,
  ...(node.expectedPrecision==='date'&&node.expectedAt&&/^\d{4}-\d{2}-\d{2}$/.test(node.expectedAt)?{dateTarget:node.expectedAt}:{})}));
}
