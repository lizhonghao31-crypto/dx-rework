import {preparationInvestmentRowKey,type PreparationMaterialFact,type WarehouseReceiptReconciliation,type WarehouseReceiptWorkItem} from '@dx-rework/contracts/production-readiness';
import {preparationHash} from './preparation-material-repository.js';
import {scopedWarehouseReceiptQuantity,warehouseReceiptBatches,warehouseFabricInspectionThreshold,warehouseMaterialBalance,type WarehouseReceiptMovement} from './warehouse-material-balance.js';

type Ref=WarehouseReceiptMovement['original'];
type Purchase=WarehouseReceiptWorkItem['purchase'];
type Basis=WarehouseReceiptWorkItem['basis'];
const key=(ref:Ref)=>JSON.stringify([ref.recordId,ref.version]);
export const warehouseLegacyQuantityIdentity=(ref:Ref,quantityRowKey:string)=>JSON.stringify([ref.recordId,ref.version,quantityRowKey]);
const same=(a:Ref,b:Ref)=>a.recordId===b.recordId&&a.version===b.version;
const time=(value:string|null)=>value?Date.parse(value):NaN;
const original=(row:PreparationMaterialFact)=>({recordId:row.recordId,version:row.version});
const validState=(row:PreparationMaterialFact)=>row.state==='partial'||row.state==='ready';
export type ReconciliationBinding=Omit<Extract<WarehouseReceiptReconciliation,{action:'confirm'}>,'action'|'expectedGeneration'> & {
 generation:number;state:'confirmed'|'revoked';recordedAt:string;proofValid:boolean;
};

export function warehouseLegacyReceiptHeads(history:readonly PreparationMaterialFact[],basis:Basis){
 const heads=new Map<string,PreparationMaterialFact>();
 for(const fact of history){
  if(fact.warehouseReceipt||fact.kind!==basis.kind||fact.scopeRef!==basis.scopeRef)continue;
  const prior=heads.get(fact.recordId);
  if(!prior||fact.version>prior.version)heads.set(fact.recordId,fact);
 }
 return [...heads.values()];
}

export function projectWarehouseReceiptReconciliation(input:{
 basis:Basis;purchase:Purchase;history:readonly PreparationMaterialFact[];movements:readonly WarehouseReceiptMovement[];
 bindings:readonly ReconciliationBinding[];asOf:string;attributedElsewhere?:ReadonlySet<string>;
}):NonNullable<WarehouseReceiptWorkItem['reconciliation']>{
 const {basis,purchase,history,asOf}=input,cutoff=time(asOf);
 const native=input.movements.filter(row=>!Number.isFinite(time(row.occurredAt))||time(row.occurredAt)<=cutoff);
 const quantity=scopedWarehouseReceiptQuantity(basis,native,asOf);
 const replaced=new Set(native.flatMap(row=>row.replaces?[key(row.replaces)]:[]));
 const effective=quantity?native.filter(row=>!replaced.has(key(row.original))):[];
 const priorHeads=warehouseLegacyReceiptHeads(history.filter(row=>!Number.isFinite(time(row.occurredAt))||time(row.occurredAt)<=cutoff),basis)
  .sort((a,b)=>key(original(a)).localeCompare(key(original(b))));
 const relevant=input.bindings.filter(row=>row.materialId===basis.materialId&&row.lineId===basis.lineId&&row.scopeRef===basis.scopeRef);
 const pending:NonNullable<WarehouseReceiptWorkItem['reconciliation']>['pending']=[];
 const confirmed:NonNullable<WarehouseReceiptWorkItem['reconciliation']>['confirmed']=[];
 const valid:NonNullable<WarehouseReceiptWorkItem['reconciliation']>['activeBatches']=[];
 const comparedIdentities=new Set<string>();
 for(const prior of priorHeads.filter(validState)){
  for(const value of prior.quantities){
   if(value.quantity<=0||value.materialId&&value.materialId!==basis.materialId||
    value.lineId&&basis.lineId&&value.lineId!==basis.lineId)continue;
   const ref=original(prior),rowKey=preparationInvestmentRowKey(value);
   if(input.attributedElsewhere?.has(warehouseLegacyQuantityIdentity(ref,rowKey)))continue;
   const rowBindings=input.bindings.filter(row=>same(row.legacy.ref,ref)&&row.legacy.quantityRowKey===rowKey);
   const binding=rowBindings.reduce<ReconciliationBinding|undefined>((old,row)=>!old||row.generation>old.generation?row:old,undefined);
   const ownsBinding=binding&&relevant.includes(binding);
   const counterpart=ownsBinding&&effective.find(row=>same(row.original,binding.batch));
   const attachmentIds=binding?.proof.mode==='document'?[...new Set([binding.proof.legacy.attachmentId,binding.proof.batch.attachmentId])]:[];
   const identity=binding?.proof.mode==='document'?JSON.stringify([binding.proof.legacy.documentNumber,binding.proof.legacy.line]):undefined;
   const compatible=binding&&counterpart&&binding.state==='confirmed'&&binding.proofValid&&
    binding.unit===basis.unit&&binding.supplierId===basis.supplierId&&binding.materialFingerprint===basis.adoptedRef&&
    same(binding.investment,purchase.original)&&value.unit===basis.unit&&Number.isFinite(time(prior.occurredAt))&&
    Boolean(prior.valid)&&Boolean(value.lineId===basis.lineId||value.lineId===null&&basis.lineId!==null)&&
    (!identity||binding.relation==='same_batch'||!comparedIdentities.has(identity));
   if(compatible){
    if(identity&&binding.relation==='independent')comparedIdentities.add(identity);
    const quantity={quantity:String(value.quantity),unit:value.unit};
    confirmed.push({ref,quantityRowKey:rowKey,quantity,generation:binding.generation,batch:binding.batch,relation:binding.relation,attachmentIds});
    if(binding.relation==='independent'&&prior.occurredAt)valid.push({ref,quantityRowKey:rowKey,quantity,occurredAt:prior.occurredAt});
   }else pending.push({ref,quantityRowKey:rowKey,quantity:{quantity:String(value.quantity),unit:value.unit},occurredAt:prior.occurredAt,
    reason:!prior.valid?prior.invalidReasons.join('；')||'原收料证据失效':value.unit!==basis.unit?'原收料单位与采购单位不同':
     binding?.state==='confirmed'&&!ownsBinding?'该原数量行曾归于其它采购范围且依据待核，请核对后撤销原关系':
     binding?.state==='confirmed'?'原批、采购版本或核对凭证已变化，请重新核对':'缺少原采购归属及批次关系的有效凭证',
    evidenceIds:prior.evidenceIds,generation:binding?.generation??0,...(binding?{bindingState:binding.state==='confirmed'&&!ownsBinding?'other_scope':binding.state}:{})});
  }
 }
 // A different warehouse stream cannot silently complete an unavailable or
 // superseded occurrence. Keep known native amounts visible beside pending facts.
 const nativeNeedsReview=native.length>0&&!quantity;
 const activeBatches:NonNullable<WarehouseReceiptWorkItem['reconciliation']>['activeBatches']=[...effective.flatMap(row=>row.occurredAt?
  [{ref:row.original,quantity:row.quantity,occurredAt:row.occurredAt}]:[]),...valid];
 const verified=warehouseReceiptBatches(basis.unit,activeBatches.map(row=>({
  id:JSON.stringify([row.ref,row.quantityRowKey??null]),quantity:row.quantity,
 })));
 const received=verified&&pending.length===0&&!nativeNeedsReview?verified:null;
 const first=activeBatches.filter(row=>Number(row.quantity.quantity)>0)
  .sort((a,b)=>time(a.occurredAt)-time(b.occurredAt)||key(a.ref).localeCompare(key(b.ref)))[0]??null;
 return {asOf,basisRevision:preparationHash({basis,purchase,native,legacy:priorHeads.map(row=>[original(row),row.valid,row.occurredAt,row.state,row.quantities]),
  bindings:input.bindings.filter(row=>priorHeads.some(prior=>same(original(prior),row.legacy.ref)))
   .map(row=>[row.legacy,row.generation,row.state,row.proofValid,row.materialId,row.lineId])
   .sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))),attributedElsewhere:[...input.attributedElsewhere??[]].sort()}),
  verified,received,pending,confirmed,nativeNeedsReview,activeBatches,firstArrival:!received?null:first,
  procurementRemaining:warehouseMaterialBalance({unit:basis.unit,invested:purchase.invested,received,productionRequired:null,
   usableAfterOccupancy:null,dispatchRequired:null,dispatched:null}).procurementRemaining,
  eligibleForInspection:basis.kind==='fabric_receipt'&&warehouseFabricInspectionThreshold(basis.unit,purchase.invested,received)===true};
}
