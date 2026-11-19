import type {PoolClient} from 'pg';
import type {CockpitFact,CockpitFactStatus,CockpitHomeFacts,OrderJourney} from '@dx-rework/contracts/digital-production-journey';
import type {TrustedActorContext} from '../tools/repositories.js';
import {canReadProductionReporting,factoryProductionVisibilityFor,productionVisibilityArgs} from '../sourcing/production-reporting-service.js';

const tone: Record<CockpitFactStatus,CockpitFact['tone']> = {
 not_started:'gray',partial:'blue',complete:'green',no_record:'neutral',not_applicable:'neutral',unavailable:'neutral'
};
const labels = {
 production:['未开始','进行中','已完成'],
 receiving:['未收货','部分收货','已收齐'],
 shipSample:['未寄出','部分寄出','已寄出']
} as const;
type FactKind=keyof typeof labels;

export function cockpitFact(kind:FactKind,status:CockpitFactStatus,scope:CockpitFact['scope']):CockpitFact{
 const label=status==='not_started'?labels[kind][0]:status==='partial'?labels[kind][1]:status==='complete'?labels[kind][2]:
   status==='not_applicable'?'不适用':status==='no_record'?'暂无记录':'暂不可用';
 return {status,tone:tone[status],label,scope};
}

type FactoryScope = {lineId:string;quantity:number;visible:boolean;status:string|null};

export async function readCockpitFactoryScopes(db:PoolClient,actor:TrustedActorContext,orders:readonly {id:string;asOf:string}[]){
 const result=new Map<string,FactoryScope[]>();
 if(!orders.length||!canReadProductionReporting(actor))return result;
 const rows=(await db.query<FactoryScope&{mother:string}>(`SELECT link.production_order_id AS mother,map.line_id AS "lineId",allocation.quantity,
  coalesce(${factoryProductionVisibilityFor(actor)},false) AS visible,
  current.status
  FROM jsonb_to_recordset($5::jsonb) AS requested(id uuid,"asOf" timestamptz)
  JOIN digital_production_child_links link ON link.production_order_id=requested.id
  JOIN sourcing_production_factory_orders production ON production.production_order_id=link.child_id
  JOIN sourcing_cases source_case ON source_case.sourcing_case_id=production.sourcing_case_id
  CROSS JOIN LATERAL sourcing_factory_execution_lines(production.production_order_id,production.sourcing_decision_id,requested."asOf") allocation
  JOIN digital_production_child_lines map ON map.module='production' AND map.child_id=production.production_order_id AND map.child_line_key=allocation.position::text
  JOIN digital_production_po_lines po ON po.line_id=map.line_id AND po.production_order_id=link.production_order_id
  LEFT JOIN LATERAL (SELECT state.status FROM sourcing_production_transitions state
   WHERE state.production_order_id=production.production_order_id AND state.factory_decision_id IS NOT DISTINCT FROM production.factory_decision_id
   AND state.created_at<=requested."asOf" ORDER BY state.sequence DESC LIMIT 1) current ON true
  WHERE link.module='production' AND allocation.quantity>0`,
  [...productionVisibilityArgs(actor),JSON.stringify(orders)])).rows;
 for(const {id} of orders)result.set(id,[]);
 for(const row of rows)result.get(row.mother)!.push(row);
 return result;
}

/** For a split factory assignment, visible progress can provide a partial
 * observation. An all-order assertion also needs complete PO allocation. */
export function cockpitProductionFact(lines:OrderJourney['lines'],scopes:readonly FactoryScope[]|undefined):CockpitFact{
 const fact=(status:CockpitFactStatus,scope:CockpitFact['scope'])=>cockpitFact('production',status,scope);
 if(!scopes)return fact('unavailable','unknown');
 if(!scopes.length)return fact('no_record','whole');
 const visible=scopes.filter(scope=>scope.visible);
 if(!visible.length)return fact('unavailable','unknown');
 const demand=new Map(lines.map(line=>[line.id,line.orderedQuantity])), allocated=new Map<string,number>();
 for(const {lineId,quantity} of visible)allocated.set(lineId,(allocated.get(lineId)??0)+quantity);
 const completeScope=visible.length===scopes.length&&allocated.size===demand.size&&
  demand.size>0&&[...demand].every(([lineId,quantity])=>quantity>0&&allocated.get(lineId)===quantity);
 const done=(scope:FactoryScope)=>scope.status==='production_completed'||scope.status==='shipped';
 if(completeScope&&visible.every(done))return fact('complete','whole');
 if(visible.some(scope=>done(scope)||scope.status==='in_production'))return fact('partial',completeScope?'whole':'visible');
 return fact('no_record',completeScope?'whole':'visible');
}

export function cockpitHomeFacts(input:{
 orderId:string|null;fullOrder:boolean;lines:OrderJourney['lines'];factories?:readonly FactoryScope[]|undefined;
 receipts?:ReadonlyArray<{lineId:string;demand:number;received:number;recorded:boolean}>|undefined;
 sentLineIds:ReadonlySet<string>;sampleApplicable:boolean|undefined;sampleWaiting:boolean;
}):CockpitHomeFacts{
 const {orderId,fullOrder,lines,factories,receipts,sentLineIds,sampleApplicable,sampleWaiting}=input;
 if(!orderId||!fullOrder){
  const status=orderId?'unavailable':'not_applicable',scope=orderId?'unknown':'whole';
  return {production:cockpitFact('production',status,scope),receiving:{...cockpitFact('receiving',status,scope),received:null,demand:null},shipSample:cockpitFact('shipSample',status,scope)};
 }
 const receivingRows=receipts?.filter(line=>line.recorded)??[];
 const receivingComplete=lines.length>0&&receivingRows.length===lines.length&&lines.every(line=>
  receivingRows.some(receipt=>receipt.lineId===line.id&&receipt.demand===line.orderedQuantity&&receipt.demand>0));
 const receiptScope=receivingComplete?'whole':receivingRows.length?'visible':'unknown';
 const receiptStatus: CockpitFactStatus=!receipts?'unavailable':!receivingRows.length?'no_record':
  receivingComplete&&receivingRows.every(line=>line.received>=line.demand)?'complete':
  receivingComplete&&receivingRows.every(line=>line.received===0)?'not_started':
  receivingRows.some(line=>line.received>0)?'partial':'no_record';
 const sent=lines.filter(line=>sentLineIds.has(line.id)).length;
 const sampleStatus:CockpitFactStatus=sampleApplicable===false?'not_applicable':lines.length>0&&sent===lines.length?'complete':
  sent?'partial':sampleApplicable===true&&sampleWaiting?'not_started':'no_record';
 return {
  production:cockpitProductionFact(lines,factories),
  receiving:{...cockpitFact('receiving',receiptStatus,receiptScope),
   received:receivingRows.length?receivingRows.reduce((sum,line)=>sum+line.received,0):null,
   demand:receivingRows.length?receivingRows.reduce((sum,line)=>sum+line.demand,0):null},
  shipSample:cockpitFact('shipSample',sampleStatus,'whole')
 };
}
