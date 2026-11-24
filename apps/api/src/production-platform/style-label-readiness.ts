import type {PreparationMaterialFact} from '@dx-rework/contracts/production-readiness';
import type {SeriesObservedFact} from '@dx-rework/contracts/digital-series-plan';
import {currentPreparationMaterials,preparationAdoption,preparationContext,preparationMaterialHistory,type PreparationDB} from './preparation-material-repository.js';
import {evaluateStyleLabels,styleLabelScope,type StyleLabelRequest} from './style-label-evidence.js';

type Context=Awaited<ReturnType<typeof preparationContext>>;
type Snapshot={context:Context;adopted?:boolean;currentMaterials:readonly PreparationMaterialFact[];history:readonly PreparationMaterialFact[]};

/** Internal reader. A supplied basis is only valid for the caller's same DB snapshot. */
export async function readStyleLabelReadiness(db:PreparationDB,orderId:string,requests:readonly StyleLabelRequest[]=[],basis?:Snapshot|{adopted:boolean}){
 const snapshot=basis&&'context' in basis?basis:undefined;
 const context=snapshot?.context??await preparationContext(db,{kind:'order',id:orderId});
 if(context.orderId!==orderId)throw Error('款号唛资料与当前订单不一致');
 const adopted=basis?.adopted??Boolean(await preparationAdoption(db,{kind:'order',id:orderId}));
 const history=snapshot?.history??await preparationMaterialHistory(db,context);
 const materials=snapshot?.currentMaterials??currentPreparationMaterials([...history],orderId);
 const requirements=context.lines.map(row=>({lineId:String(row.line_id),quantity:Number(row.order_quantity)}));
 return {adopted,...evaluateStyleLabels(orderId,requirements,materials,requests,history)};
}

export function styleLabelObservedFacts(readiness:Awaited<ReturnType<typeof readStyleLabelReadiness>>):SeriesObservedFact[]{
 const {orderId,ruleVersion,requirementsRevision,evidenceRevision,adopted,lines,whole}=readiness;
 const observed=(lineId:string|null,completed:boolean,completedAt:string|null,startedAt:string|null,reason:string|null,
  materialRecords:NonNullable<SeriesObservedFact['derivation']>['materialRecords'],completionRecords:NonNullable<SeriesObservedFact['derivation']>['completionRecords']):SeriesObservedFact=>({
   key:'style_label_ready',scopeRef:styleLabelScope(lineId),sourceDomain:'style-label-readiness',sourceRecordId:orderId,sourceVersion:ruleVersion,
   completed:adopted&&completed,started:Boolean(startedAt),occurredAt:adopted?completedAt:null,occurredDate:null,precision:adopted&&completedAt?'instant':'unknown',
   reason:adopted?reason:'历史单未采用款号唛资料规则，原记录保留',derivation:{requirementsRevision,evidenceRevision,lineId,startedAt,materialRecords,completionRecords},
  });
 return [...[...lines.values()].map(row=>observed(row.lineId,row.status==='sufficient',row.completedAt,row.startedAt,row.reason,
  row.record?[row.record]:[],row.completionRecord?[row.completionRecord]:[])),
  observed(null,whole.sufficient,whole.completedAt,whole.startedAt,whole.reason,whole.records,whole.completionRecords)];
}

/** Framework facts are selected by the native PO identity. No whole fallback or old completion is valid for a missing PO. */
export function styleLabelObservedFact(rows:readonly SeriesObservedFact[],lineId:string|null){
 const fact=rows.find(row=>row.key==='style_label_ready'&&row.sourceDomain==='style-label-readiness'&&row.scopeRef===styleLabelScope(lineId));
 return {completed:fact?.completed??false,occurredAt:fact?.occurredAt??null,
  evidenceRefs:fact?[`style-label-readiness:${fact.sourceRecordId}:${fact.scopeRef}:v${fact.sourceVersion}`,
   ...[...new Set([...(fact.derivation?.materialRecords??[]),...(fact.derivation?.completionRecords??[])].map(record=>`style-label-material:${record.recordId}:${fact.scopeRef}:v${record.version}`))]]:[]};
}
