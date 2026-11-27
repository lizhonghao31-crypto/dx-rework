import type {WarehouseMaterialQuantity,WarehouseReceiptMovement} from './warehouse-material-balance.js';

export type WarehouseLotRef=WarehouseReceiptMovement['original'];
export type WarehouseIssueAllocation={receipt:WarehouseLotRef;quantity:string};
export type WarehouseLotIssue={occurredAt:string;allocations:readonly WarehouseIssueAllocation[]};
const decimal=(quantity:string)=>{
 if(!/^\d{1,18}(?:\.\d{1,6})?$/.test(quantity))return null;
 const [whole='',fraction='']=quantity.split('.');
 return BigInt(whole+fraction.padEnd(6,'0'));
};
const plain=(amount:bigint)=>{
 const digits=amount.toString().padStart(7,'0');
 const fraction=digits.slice(-6).replace(/0+$/,'');
 return digits.slice(0,-6)+(fraction?'.'+fraction:'');
};
const ref=(value:WarehouseLotRef)=>JSON.stringify([value.recordId,value.version,value.quantityRowKey??null]);

/** A correction is a replacement of the same physical lot, not a new
 * entitlement to ship. Occupations retain the original ref for audit. A
 * caller must supply the exact adopted material/PO stream and all relevant
 * original issues; an opaque historical issue must be represented by null. */
export function projectWarehouseIssueAllocation(unit:string,receipts:readonly WarehouseReceiptMovement[],issues:readonly WarehouseLotIssue[]|null){
 if(!unit||!receipts.length||!issues)return null;
 const basis=JSON.stringify(receipts[0]!.basis);
 const live=new Map<string,{receipt:WarehouseLotRef;quantity:bigint;at:number}>();
 const roots=new Map<string,string>();
 for(const row of receipts){
  const quantity=decimal(row.quantity.quantity),id=ref(row.original),replaced=row.replaces?ref(row.replaces):null,at=Date.parse(row.occurredAt??'');
  if(!row.valid||JSON.stringify(row.basis)!==basis||row.quantity.unit!==unit||row.basis.unit!==unit||quantity===null||roots.has(id)||!Number.isFinite(at))return null;
  const root=replaced?roots.get(replaced):id;
  if(!root||replaced&&ref(live.get(root)?.receipt??{recordId:'',version:0})!==replaced)return null;
  roots.set(id,root);live.set(root,{receipt:row.original,quantity,at});
 }
 const occupations=new Map<string,bigint>();
 for(const issue of issues){
  const issuedAt=Date.parse(issue.occurredAt);
  if(!Number.isFinite(issuedAt)||!issue.allocations.length)return null;
  const seen=new Set<string>();
  for(const item of issue.allocations){
   const amount=decimal(item.quantity),root=roots.get(ref(item.receipt)),lot=root?live.get(root):undefined;
   if(!lot||!root||!amount||seen.has(root)||issuedAt<lot.at)return null;
   seen.add(root);
   const used=(occupations.get(root)??0n)+amount;
   if(used>lot.quantity)return null;
   occupations.set(root,used);
  }
 }
 let total=0n,dispatched=0n;
 const lots=[...live].map(([root,lot])=>{
  const used=occupations.get(root)??0n;
  const remaining=lot.quantity-used;
  total+=remaining;dispatched+=used;
  return {receipt:lot.receipt,remaining:{unit,quantity:plain(remaining)},occurredAt:new Date(lot.at).toISOString()};
 });
 return {lots,available:{unit,quantity:plain(total)},dispatched:{unit,quantity:plain(dispatched)}};
}

export function availableWarehouseIssue(ledger:NonNullable<ReturnType<typeof projectWarehouseIssueAllocation>>,required:WarehouseMaterialQuantity){
 const consumed=decimal(ledger.dispatched.quantity),target=decimal(required.quantity),physical=decimal(ledger.available.quantity);
 if(required.unit!==ledger.dispatched.unit||consumed===null||target===null||physical===null||target<consumed)return null;
 const pending=target-consumed;
 return plain(pending<physical?pending:physical);
}

/** Only these current lot versions are certified for this action. Keep the
 * original occupation across all lots in the same adopted material demand. */
export function restrictWarehouseIssueLots(ledger:NonNullable<ReturnType<typeof projectWarehouseIssueAllocation>>,eligible:readonly WarehouseLotRef[]){
 const allowed=new Set(eligible.map(ref)),lots=ledger.lots.filter(lot=>allowed.has(ref(lot.receipt)));
 if(!lots.length)return null;
 const remaining=lots.reduce((total,lot)=>total+decimal(lot.remaining.quantity)!,0n);
 return {...ledger,lots,available:{quantity:plain(remaining),unit:ledger.available.unit}};
}

/** Check the current exact batch version, its physical date, the selected
 * batch quantities and original adopted demand under the caller's lock. */
export function warehouseIssueFits(ledger:ReturnType<typeof projectWarehouseIssueAllocation>,required:WarehouseMaterialQuantity,
 submitted:WarehouseMaterialQuantity,issue:WarehouseLotIssue){
 const total=decimal(submitted.quantity),demand=decimal(required.quantity),used=ledger?decimal(ledger.dispatched.quantity):null;
 if(!ledger||submitted.unit!==required.unit||ledger.dispatched.unit!==required.unit||!total||!demand||used===null||used+total>demand)return false;
 const at=Date.parse(issue.occurredAt);
 if(!Number.isFinite(at)||!issue.allocations.length)return false;
 let allocated=0n;
 const seen=new Set<string>();
 for(const item of issue.allocations){
  const id=ref(item.receipt),lot=ledger.lots.find(candidate=>ref(candidate.receipt)===id),amount=decimal(item.quantity);
  if(!lot||!amount||seen.has(id)||at<Date.parse(lot.occurredAt)||amount>decimal(lot.remaining.quantity)!)return false;
  seen.add(id);allocated+=amount;
 }
 return allocated===total;
}
