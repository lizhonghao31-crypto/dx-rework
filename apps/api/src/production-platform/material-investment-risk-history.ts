import type {PoolClient} from 'pg';
import type {JourneyRiskHistory} from '@dx-rework/contracts/digital-production-journey';
import type {PreparationMaterialFact} from '@dx-rework/contracts/production-readiness';
import {orderTimePolicyHistory} from './order-time-native-timing.js';
import {preparationContext,preparationMaterialHistory,currentPreparationMaterials} from './preparation-material-repository.js';
import {journeyTermination} from './journey-termination.js';

const investmentUrl=(orderId:string)=>`/ui/digital-production?materialOrder=${orderId}&materialKind=material_investment`;

/** Compare with the policy effective at the occurrence, once per real scope.
 * A preorder receipt before any target stays a receipt without a late result. */
export async function materialInvestmentRiskHistory(db:Pick<PoolClient,'query'>,orderId:string,asOf:string){
 const resource={kind:'order' as const,id:orderId};
 const versions=(await orderTimePolicyHistory(db,resource)).filter(version=>version.history?.input.materialInvestmentScope?.reference.startsWith('preorder:'));
 if(!versions.length)return [];
 const context=await preparationContext(db,resource),history=await preparationMaterialHistory(db,context);
 const ready=history.filter(row=>row.kind==='material_investment'&&row.state==='ready'&&row.occurredAt&&row.investmentScopeBasis);
 const entries:Array<{record:PreparationMaterialFact;at:string;terminationRef?:string|null}>=ready.map(record=>({record,at:record.occurredAt!}));
 const heads=currentPreparationMaterials(history,orderId),handover=heads.find(row=>row.kind==='design_handover'&&row.scopeRef==='whole'&&row.state==='ready'&&row.investmentScopeBasis);
 const investment=heads.find(row=>row.kind==='material_investment'&&row.scopeRef==='whole');
 if(handover&&investment?.state!=='ready'){
  const stopped=await journeyTermination(db,resource,asOf)??(context.sourceId?await journeyTermination(db,{kind:'source',id:context.sourceId},asOf):null);
  if(stopped?.at)entries.push({record:handover,at:stopped.at,terminationRef:stopped.originEventRef});
 }
 const result:JourneyRiskHistory[]=[];
 for(const {record,at,terminationRef} of entries){
  const clock=Date.parse(at);
  if(!record.investmentScopeBasis||clock>Date.parse(asOf))continue;
  const version=versions.find(row=>Date.parse(row.at)<=clock);
  if(!version?.history)continue;
  for(const [scope,plan] of Object.entries(version.history.input.frameworkPlans??{})){
   const milestone=plan.milestones.find(row=>row.key==='material_investment');
   if(!milestone?.target.at||!milestone.materialInvestmentTargetBasis?.scope?.reference.endsWith(':'+record.investmentScopeBasis.fingerprint))continue;
   const difference=clock-Date.parse(milestone.target.at),late=difference>0||difference===0&&milestone.target.exclusive;
   const lineId=version.history.input.scopes.find(row=>row.scopeRef===scope)?.lineId??null;
   result.push({eventId:`${terminationRef??record.recordId}:${record.version}:${scope}`,nodeId:`framework-event:${scope}:material_investment`,
    label:'投面辅料',round:null,at,deadline:milestone.target.at,assessment:late?'late':'not_late',overdueSeconds:Math.max(0,difference/1000),
    record:{domain:'preparation',id:orderId,url:investmentUrl(orderId),mode:'read',version:record.version,lineId}});
  }
 }
 return result;
}
