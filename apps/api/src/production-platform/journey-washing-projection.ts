import {businessRoleLabel} from '@dx-rework/contracts/business-display';
import type {FixedScheduleProgress} from '@dx-rework/contracts';
import type {JourneyNode,JourneyStageKey,OrderJourney} from '@dx-rework/contracts/digital-production-journey';
import type {FixedScheduleBasis} from './fixed-schedule-basis.js';
import {stageState} from './journey-projection.js';

const prefix='washing-work:';
const definitions:Record<string,{label:string;stage:JourneyStageKey;inspection:boolean}>={
 bulk_factory_washing:{label:'工厂大货洗水',stage:'production',inspection:false},
 bulk_factory_washing_inspection:{label:'工厂洗后检查',stage:'production',inspection:true},
 bulk_return_washing:{label:'回货后另送洗',stage:'receiving',inspection:false},
 bulk_return_washing_inspection:{label:'另送洗洗后检查',stage:'receiving',inspection:true},
};
/** References to adopted original washing work, not newly created tasks. The
 * same captured basis already contains quantity coverage and native windows. */
export function attachJourneyWashing(item:OrderJourney,basis:FixedScheduleBasis,progress:FixedScheduleProgress){
 if(!item.orderId)return;
 const changed=new Set<JourneyStageKey>();
 for(const stage of item.stages){if(stage.nodes.some(node=>node.instanceId.startsWith(prefix)))changed.add(stage.key);stage.nodes=stage.nodes.filter(node=>!node.instanceId.startsWith(prefix));}
 for(const scope of basis.scopes)for(const work of scope.work){
  const key=work.id.split(':')[0]!;if(!Object.hasOwn(definitions,key))continue;
  const definition=definitions[key]!,stage=item.stages.find(stage=>stage.key===definition.stage);if(!stage)continue;
  const fact=scope.facts[work.id],target=progress.scopes.find(row=>row.scopeRef===scope.scopeRef)?.nodes.find(node=>node.id===work.id);
  const complete=fact?.businessCompleted===true,actual=complete?fact?.completed:undefined,stopped=Boolean(basis.termination||fact?.terminated),windows=fact?.ownWindows??[];
  const entered=fact?.clockStart.precision==='instant'?fact.clockStart.at:null,executed=Boolean(entered||windows.length||complete);
  const po=item.lines.find(line=>line.id===scope.lineId),label=po?`PO ${po.po??po.color}`:'本单适用PO';
  const risks:JourneyNode['risks']=[];
  if(!complete&&!stopped){
   if(target?.goalDelta.kind==='late'||target?.ownSla.state==='overdue')risks.push('overdue');else if(target?.ownSla.warning)risks.push('due_soon');
   if(!fact||!target||executed&&target.ownSla.state==='unknown')risks.push('unknown');
  }
  if(complete&&(!actual||actual.precision==='unknown'))risks.push('unknown');
  stage.nodes.push({key,instanceId:`${prefix}${scope.scopeRef}:${work.id}`,label:definition.label,stage:definition.stage,
   state:complete?'completed':stopped?'cancelled':executed?'active':'pending',current:true,round:null,occurrence:null,
   owner:null,ownerStatus:'unknown',operator:null,responsibilityRole:businessRoleLabel(definition.inspection?'quality_control':'embroidery_washing_merchandiser'),assignmentHistory:[],subject:label,
   countsInProgress:true,progressApplicability:fact&&target?'applicable':'unknown',
   expectedAt:null,expectedKind:'unset',expectedPrecision:'missing',enteredAt:entered,
   actualAt:actual?.precision==='instant'?actual.at:null,...(actual?.precision==='date'?{actualDate:actual.date}:{}),actualQuality:actual&&actual.precision!=='unknown'?'verified':'missing',
   sla:complete||stopped?'finished':entered?'running':'not_started',completionResult:complete?target?.goalDelta.kind==='late'?'late':target?.goalDelta.kind==='early'?'early':target?.goalDelta.kind==='on_target'?'on_time':'unknown':null,overdueSeconds:null,
   ...(target?{fixedTargets:[{scopeRef:scope.scopeRef,lineId:scope.lineId,progress:target}]}:{}),
   nativeWindows:windows.map(window=>({evidence:window.sourceRef,scopeLabel:`${label} · 原洗水批次`,startedAt:window.started.precision==='instant'?window.started.at:null,completedAt:window.completed.precision==='instant'?window.completed.at:null,deadline:window.deadline,warningAt:window.warningAt,complete:window.complete})),
   risks,blockers:[],records:[{domain:'factory',id:item.orderId,url:`/ui/digital-production?factory=${item.orderId}`,mode:'read',version:null,lineId:scope.lineId}],inheritedFrom:null,unavailableReason:null});
  changed.add(stage.key);
 }
 for(const stage of item.stages)if(changed.has(stage.key))stage.state=stageState(stage.nodes.filter(node=>node.current));
}
