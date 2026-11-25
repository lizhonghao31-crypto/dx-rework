import type {FactoryScope} from './factory-batch-ledger.js';

export type WarehouseCraftIdentity={orderId:string;preparationId:string;stepRef:string};
export type WarehouseCraftSource=WarehouseCraftIdentity&{factId:string|null;factoryId:string;occurredAt:string;
 quantities:readonly {lineId:string;remaining:number}[]};
type WarehouseCraftOccupation={lineId:string;quantity:number};
export type WarehouseCraftOccupationSnapshot=WarehouseCraftIdentity&{sourceFactId:string|null;lines:readonly WarehouseCraftOccupation[]};
type WarehouseCraftMotion={kind:'send'|'return';scope:WarehouseCraftIdentity;sourceFactId:string|null;factoryId:string;occurredAt:string;lines:readonly FactoryScope[]};

/** Shared precondition for the exact warehouse handling of an original cut,
 * previous released lot or outgoing lot. `occupation` is an authoritative
 * current X5 read for this exact origin (also when empty). Unknown cannot be
 * treated as zero. An original-process return remains bound to the factory
 * actually used; it does not adopt a replacement current quotation. */
export function qualifyWarehouseCraftMovement({motion,original,occupation,asOf}:{motion:WarehouseCraftMotion;original:WarehouseCraftSource;
 occupation:WarehouseCraftOccupationSnapshot|null;asOf:string}):FactoryScope[]|null{
 const at=Date.parse(motion.occurredAt),sourceAt=Date.parse(original.occurredAt),now=Date.parse(asOf);
 if(!occupation||!motion.scope.stepRef||!motion.scope.preparationId||!motion.scope.orderId||!original.factoryId||
    motion.scope.orderId!==original.orderId||motion.scope.preparationId!==original.preparationId||motion.scope.stepRef!==original.stepRef||
    occupation.orderId!==original.orderId||occupation.preparationId!==original.preparationId||occupation.stepRef!==original.stepRef||occupation.sourceFactId!==original.factId||
    motion.factoryId!==original.factoryId||motion.sourceFactId!==original.factId||motion.kind==='return'&&!original.factId||
    !Number.isFinite(at)||!Number.isFinite(sourceAt)||!Number.isFinite(now)||at<sourceAt||at>now||!motion.lines.length||
    new Set(motion.lines.map(line=>line.lineId)).size!==motion.lines.length||
    new Set(original.quantities.map(line=>line.lineId)).size!==original.quantities.length)return null;
 const available=new Map<string,number>();
 for(const source of original.quantities){
  if(!source.lineId||!Number.isSafeInteger(source.remaining)||source.remaining<0)return null;
  available.set(source.lineId,source.remaining);
 }
 for(const piece of occupation.lines){
  const prior=available.get(piece.lineId);
  if(prior===undefined||!Number.isSafeInteger(piece.quantity)||piece.quantity<0||piece.quantity>prior)return null;
  available.set(piece.lineId,prior-piece.quantity);
 }
 for(const line of motion.lines)if(!Number.isSafeInteger(line.quantity)||line.quantity<=0||line.quantity>(available.get(line.lineId)??0))return null;
 return motion.lines.map(line=>({...line}));
}
