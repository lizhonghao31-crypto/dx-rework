import {preparationInvestmentRowKey,type PreparationMaterialFact} from '@dx-rework/contracts/production-readiness';

export type WarehouseMaterialQuantity = Readonly<{ quantity: string; unit: string }>;

type NativeWarehouseReceipt = Readonly<{
  resource: { kind: 'order' | 'source'; id: string };
  scopeRef: string;
  kind: 'fabric_receipt' | 'accessories_ready';
  state: string;
  valid: boolean;
  occurredAt: string | null;
  quantities: readonly { materialId: string | null; lineId: string | null; quantity: number; unit: string }[];
}>;

type MaterialBalanceFacts = Readonly<{
  unit: string | null;
  invested: WarehouseMaterialQuantity | null;
  received: WarehouseMaterialQuantity | null;
  productionRequired: WarehouseMaterialQuantity | null;
  usableAfterOccupancy: WarehouseMaterialQuantity | null;
  dispatchRequired: WarehouseMaterialQuantity | null;
  dispatched: WarehouseMaterialQuantity | null;
}>;

type Decimal = { coefficient: bigint; scale: number };

function decimal(value: WarehouseMaterialQuantity | null, unit: string | null): Decimal | null {
  if (!value || !unit || value.unit !== unit || !/^\d+(?:\.\d+)?$/.test(value.quantity)) return null;
  const [whole, fraction = ''] = value.quantity.split('.');
  return { coefficient: BigInt(whole + fraction), scale: fraction.length };
}

/** Compare two positive quantities already expressed in the same actual unit. */
export function comparePositiveMaterialQuantities(left:WarehouseMaterialQuantity,right:WarehouseMaterialQuantity){
  if(left.unit!==right.unit)return null;
  const a=decimal(left,left.unit),b=decimal(right,left.unit);
  if(!a||!b||a.coefficient<=0n||b.coefficient<=0n)return null;
  const scale=Math.max(a.scale,b.scale);
  const lhs=a.coefficient*10n**BigInt(scale-a.scale),rhs=b.coefficient*10n**BigInt(scale-b.scale);
  return lhs<rhs?-1:lhs>rhs?1:0;
}

function difference(left: Decimal | null, right: Decimal | null): string | null {
  if (!left || !right) return null;
  const scale = Math.max(left.scale, right.scale);
  const delta = left.coefficient * 10n ** BigInt(scale - left.scale) - right.coefficient * 10n ** BigInt(scale - right.scale);
  if (delta <= 0n) return '0';
  if (scale === 0) return delta.toString();
  const padded = delta.toString().padStart(scale + 1, '0');
  const fraction = padded.slice(-scale).replace(/0+$/, '');
  return fraction ? `${padded.slice(0, -scale)}.${fraction}` : padded.slice(0, -scale);
}

/** A single current native snapshot, not the sum of obsolete versions. A
 * historical ready flag without actual quantities is not receipt evidence. */
export function currentWarehouseReceiptQuantity(fact: NativeWarehouseReceipt | null, scope: Readonly<{
  resource: NativeWarehouseReceipt['resource']; kind: NativeWarehouseReceipt['kind']; scopeRef: string;
  materialId: string; lineId: string | null; unit: string;
}>): WarehouseMaterialQuantity | null {
  if (!fact?.valid || !fact.occurredAt || !Number.isFinite(Date.parse(fact.occurredAt)) ||
      !['ready', 'partial'].includes(fact.state) || fact.kind !== scope.kind || fact.scopeRef !== scope.scopeRef ||
      fact.resource.kind !== scope.resource.kind || fact.resource.id !== scope.resource.id) return null;
  const rows = fact.quantities.filter(row => row.materialId === scope.materialId && row.lineId === scope.lineId);
  if (rows.length !== 1 || !Number.isFinite(rows[0]!.quantity) || rows[0]!.quantity < 0 || rows[0]!.unit !== scope.unit) return null;
  const quantity = String(rows[0]!.quantity);
  return decimal({ quantity, unit: scope.unit }, scope.unit) ? { quantity, unit: scope.unit } : null;
}

/**
 * Project the physical receipt stream for one exact adopted material. An
 * independent receipt is additive. A correction must point to an active
 * event in this same stream; the replaced event remains in original history.
 * Unknown is not zero, including mixed/unproved units or broken links.
 */
export function warehouseReceiptBatches(unit:string, events:readonly {
  id:string;quantity:WarehouseMaterialQuantity;replaces?:string;
}[]):WarehouseMaterialQuantity|null{
 if(!unit||!events.length)return null;
 const seen=new Set<string>(),live=new Map<string,Decimal>();
 for(const event of events){
  if(!event.id||seen.has(event.id))return null;
  const amount=decimal(event.quantity,unit);
  if(!amount)return null;
  if(event.replaces&&!live.delete(event.replaces))return null;
  seen.add(event.id);live.set(event.id,amount);
 }
 let coefficient=0n,scale=0;
 for(const amount of live.values()){
  const common=Math.max(scale,amount.scale);
  coefficient=coefficient*10n**BigInt(common-scale)+amount.coefficient*10n**BigInt(common-amount.scale);
  scale=common;
 }
 return {unit,quantity:difference({coefficient,scale},{coefficient:0n,scale:0})!};
}

export type WarehouseReceiptBasis = Readonly<{
  resource: NativeWarehouseReceipt['resource'];
  kind: NativeWarehouseReceipt['kind'];
  scopeRef: string;
  materialId: string;
  lineId: string | null;
  adoptedRef: string;
  /** A registered supplier of the adopted material, not its display name. */
  supplierId: string | null;
  unit: string;
}>;
type OriginalReceiptRef = Readonly<{recordId:string;version:number}>;
export type WarehouseReceiptMovement = Readonly<{
  basis:WarehouseReceiptBasis;
  original:OriginalReceiptRef;
  replaces?:OriginalReceiptRef;
  quantity:WarehouseMaterialQuantity;
  occurredAt:string|null;
  valid:boolean;
}>;

function receiptRef(ref:OriginalReceiptRef){
 return ref.recordId&&Number.isSafeInteger(ref.version)&&ref.version>0?JSON.stringify([ref.recordId,ref.version]):null;
}

/** Select one physical/adopted stream from authorized native facts. A shared
 * material uses a null line exactly once. An unlinked historical correction,
 * lost original proof, or unverified clock cannot produce a false balance. */
export function scopedWarehouseReceiptQuantity(basis:WarehouseReceiptBasis, rows:readonly WarehouseReceiptMovement[], asOf:string){
 const now=Date.parse(asOf);
 if(!basis.adoptedRef||!Number.isFinite(now))return null;
 const relevant=rows.filter(({basis:row})=>row.resource.kind===basis.resource.kind&&row.resource.id===basis.resource.id&&
  row.kind===basis.kind&&row.scopeRef===basis.scopeRef&&row.materialId===basis.materialId&&row.lineId===basis.lineId&&
  row.adoptedRef===basis.adoptedRef&&row.supplierId===basis.supplierId);
 const batches:{id:string;quantity:WarehouseMaterialQuantity;replaces?:string}[]=[];
 for(const current of relevant){
  const {original,replaces,quantity,valid,occurredAt}=current;
  const id=receiptRef(original),target=replaces?receiptRef(replaces):null,actual=occurredAt?Date.parse(occurredAt):NaN;
  if(!valid||!id||replaces&&!target||!Number.isFinite(actual)||actual>now||current.basis.unit!==basis.unit)return null;
  batches.push({id,quantity,...(target?{replaces:target}:{})});
 }
 return warehouseReceiptBatches(basis.unit,batches);
}

type VerifiedInvestment = Pick<PreparationMaterialFact,'resource'|'kind'|'scopeRef'|'recordId'|'version'|'valid'|'state'|
 'quantities'|'investmentScopeBasis'|'investmentMaterialOccurrences'|'investmentQuantityOccurrences'>;

/** A purchasing-backed task starts from the current native, material-level
 * investment receipt, not a draft, display name or order-wide ready marker. */
export function warehouseReceiptTaskBasis(basis:WarehouseReceiptBasis, investment:VerifiedInvestment|undefined) {
 if(!investment?.valid||investment.kind!=='material_investment'||!['ready','partial'].includes(investment.state)||
  investment.resource.kind!==basis.resource.kind||investment.resource.id!==basis.resource.id||investment.scopeRef!==basis.scopeRef)return null;
 const adopted=investment.investmentScopeBasis;
 const fingerprint=adopted?.materialFingerprints[basis.materialId];
 if(!adopted||!adopted.materialIds.includes(basis.materialId)||!fingerprint||fingerprint!==basis.adoptedRef)return null;
 const originalRows=investment.quantities.filter(row=>row.materialId===basis.materialId);
 const candidates=originalRows.filter(row=>row.lineId===basis.lineId);
 if(candidates.length!==1||candidates[0]!.unit!==basis.unit||!(candidates[0]!.quantity>0))return null;
 const selected=candidates[0]!,byRow=investment.investmentQuantityOccurrences;
 const occurrence=byRow?byRow[preparationInvestmentRowKey(selected)]:
  originalRows.length===1?investment.investmentMaterialOccurrences?.[basis.materialId]:undefined;
 if(occurrence?.fingerprint!==fingerprint||!Number.isFinite(Date.parse(occurrence.occurredAt)))return null;
 const invested={quantity:String(selected.quantity),unit:basis.unit};
 if(!decimal(invested,basis.unit))return null;
 return {invested,investedAt:occurrence.occurredAt,original:{recordId:investment.recordId,version:investment.version},
  handover:{recordId:adopted.handoverRecordId,version:adopted.handoverVersion}};
}

/** Called with the current facts for one authorized material, adopted basis
 * and physical scope. The caller owns the exact identities, legal unit
 * conversions, batch corrections, occupations and transaction. This read
 * projection never infers stock, quality clearance, or an ability to send. */
export function warehouseMaterialBalance(facts: MaterialBalanceFacts) {
  const { unit } = facts;
  const invested = decimal(facts.invested, unit), received = decimal(facts.received, unit);
  return {
    unit,
    procurementRemaining: difference(invested, received),
    excessReceived: difference(received, invested),
    productionShortage: difference(decimal(facts.productionRequired, unit), decimal(facts.usableAfterOccupancy, unit)),
    dispatchRemaining: difference(decimal(facts.dispatchRequired, unit), decimal(facts.dispatched, unit)),
  };
}
