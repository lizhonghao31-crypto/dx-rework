import type {OrderJourney,JourneyNode} from '@dx-rework/contracts/digital-production-journey';
import type {FixedScheduleProgress} from '@dx-rework/contracts';
import type {FixedScheduleBasis} from './fixed-schedule-basis.js';

const events:Record<string,{label:string;role:string}>={
 design_handover:{label:'设计资料交接',role:'设计'},material_investment:{label:'跟单投面料',role:'订单跟单'},
 fabric_receipt:{label:'面料实际到仓',role:'仓管'},
 color_confirmation:{label:'对色完成',role:'订单跟单'},style_label_ready:{label:'款号唛实物备齐',role:'仓管'},
};
/** Already authorized, same-snapshot facts. These are references to the existing
 * preparation records, not extra tasks, clocks or progress denominator items. */
export function attachFrameworkEvents(item:OrderJourney,basis:FixedScheduleBasis,progress:FixedScheduleProgress){
 if(!basis.framework||!item.orderId)return;
 const stage=item.stages.find(stage=>stage.key==='preparation');if(!stage)return;
 // The new horizontal milestones replace the old independent planning rows.
 for(const group of item.stages)group.nodes=group.nodes.filter(node=>!node.instanceId.startsWith('framework-event:')&&(!node.planningOnly||!node.key.startsWith('series_')));
 const shared=new Map<string,JourneyNode>();
 for(const scope of basis.scopes)for(const work of scope.work){
  const key=work.id.split(':')[0]!,definition=events[key],fact=scope.facts[work.id],target=progress.scopes.find(row=>row.scopeRef===scope.scopeRef)?.nodes.find(row=>row.id===work.id);
  if(!definition||!fact||!target)continue;
  const identity=JSON.stringify([work.canonicalWorkRef,fact.businessCompleted,fact.completed,fact.evidenceRefs]);
  const existing=shared.get(identity);
  if(existing){existing.fixedTargets!.push({scopeRef:scope.scopeRef,lineId:scope.lineId,progress:target});existing.subject='整款共用';for(const record of existing.records)record.lineId=null;if(target.goalDelta.kind==='late'&&!existing.risks.includes('overdue'))existing.risks.push('overdue');continue;}
  const actual=fact.completed,po=item.lines.find(line=>line.id===scope.lineId);
  const node:JourneyNode={key,instanceId:`framework-event:${scope.scopeRef}:${work.id}`,label:definition.label,stage:'preparation',
   state:fact.businessCompleted?'completed':basis.termination?'cancelled':'pending',current:true,round:null,occurrence:null,
   owner:null,ownerStatus:'unknown',operator:null,responsibilityRole:definition.role,assignmentHistory:[],...(po?{subject:po.po??po.color}:{}),
   planningOnly:true,countsInProgress:false,progressApplicability:'applicable',
   fixedTargets:[{scopeRef:scope.scopeRef,lineId:scope.lineId,progress:target}],
   expectedAt:target.currentTarget?.at??target.goalDelta.targetAt,expectedKind:'plan',expectedPrecision:'instant',
   actualAt:actual.precision==='instant'?actual.at:null,actualDate:actual.precision==='date'?actual.date:null,actualQuality:actual.precision==='unknown'?'missing':'unverified',
   enteredAt:null,sla:'not_set',completionResult:null,overdueSeconds:null,
   risks:target.goalDelta.kind==='late'?['overdue']:fact.businessCompleted&&actual.precision==='unknown'?['unknown']:[],blockers:[],
   records:[{domain:'preparation',id:item.orderId,url:`/ui/digital-production?bulk=${item.orderId}`,mode:'read',version:null,lineId:scope.lineId}],inheritedFrom:null,unavailableReason:null};
  stage.nodes.push(node);
  shared.set(identity,node);
 }
}
