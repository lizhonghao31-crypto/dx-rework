import type {SlaAnchor,SlaTime} from '@dx-rework/domain/digital-sla-plan';
import {slaAnchorTime} from '@dx-rework/domain/digital-sla-plan';
import {fixedTimelineTargets,shiftFixedTimeline,type FixedTimelineWork,type FixedTimelineTarget} from './fixed-timeline-targets.js';

export type ShipSampleTarget={nodeId:string;productionNodeId:string;customerGoalId:string;advanceDays:number|null};
/** The original PO target rule: ship sample is due before both production
 * starts and the customer's offset. It is not a second delivery critical path. */
export function fixedConsumerTargets(work:FixedTimelineWork[],consumer:{ends:Record<string,SlaAnchor>;shipSample?:ShipSampleTarget},goals=consumer.ends,fixedTargets?:Readonly<Record<string,FixedTimelineTarget>>){
 const options={preserveUnknown:true,...(fixedTargets?{fixedTargets}:{})};
 const first=fixedTimelineTargets(work,goals,options),rule=consumer.shipSample;if(!rule)return first;
 const production=first.find(node=>node.id===rule.productionNodeId)?.start,customer=slaAnchorTime(goals[rule.customerGoalId]??{precision:'unknown',reason:'缺少本PO正式客户交期'},rule.customerGoalId);
 const limit:SlaTime=customer.at&&rule.advanceDays!==null?{...customer,at:shiftFixedTimeline(customer.at,-rule.advanceDays*1440,'natural_days')}
  :{at:null,exclusive:false,reasons:[...customer.reasons,'尚未采用本PO寄船样提前量']};
 const end:SlaTime=production?.at&&limit.at?Date.parse(production.at)<=Date.parse(limit.at)?production:limit
  :{at:null,exclusive:false,reasons:[...(production?.reasons??['计划生产开始尚未确定']),...limit.reasons]};
 return fixedTimelineTargets(work,goals,{...options,endTimes:{[rule.nodeId]:end}});
}
