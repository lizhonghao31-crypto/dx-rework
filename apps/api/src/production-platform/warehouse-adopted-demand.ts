import type {WarehouseMaterialQuantity} from './warehouse-material-balance.js';

type Scope={lineId:string;pieces:number};
type ProductionDemandEvidence={
 capturedInstructionVersion:number;activeInstructionVersion:number|null;
 instructionMaterialId:string;boundInstructionMaterialId:string;sourceMaterialId:string;
 artifactMaterialId:string;lineId:string|null;unit:string;
 perPiece:WarehouseMaterialQuantity;adoptedLines:readonly Scope[];
};

/** Only the published material's explicitly matched technical use and frozen
 * PO amounts can express demand. Nothing here treats purchases as stock or as
 * required production quantity. The caller must supply original bindings. */
export function warehouseAdoptedDemand(evidence:ProductionDemandEvidence):WarehouseMaterialQuantity|null{
 const {capturedInstructionVersion,activeInstructionVersion,instructionMaterialId,boundInstructionMaterialId,
  sourceMaterialId,artifactMaterialId,lineId,unit,perPiece,adoptedLines}=evidence;
 if(!Number.isSafeInteger(capturedInstructionVersion)||capturedInstructionVersion<=0||capturedInstructionVersion!==activeInstructionVersion||
    !instructionMaterialId||instructionMaterialId!==boundInstructionMaterialId||!sourceMaterialId||sourceMaterialId!==artifactMaterialId||
    !unit||unit!==perPiece.unit||!/^\d{1,18}(?:\.\d{1,12})?$/.test(perPiece.quantity)||!adoptedLines.length||
    new Set(adoptedLines.map(scope=>scope.lineId)).size!==adoptedLines.length||
    adoptedLines.some(scope=>!scope.lineId||!Number.isSafeInteger(scope.pieces)||scope.pieces<=0))return null;
 const selected=lineId?adoptedLines.filter(line=>line.lineId===lineId):adoptedLines;
 if(!selected.length)return null;
 const pieces=selected.reduce((sum,scope)=>sum+BigInt(scope.pieces),0n);
 const [integer='',fraction='']=perPiece.quantity.split('.');
 const product=BigInt(integer+fraction)*pieces;
 if(product<=0n)return null;
 if(!fraction.length)return {unit,quantity:product.toString()};
 const digits=product.toString().padStart(fraction.length+1,'0');
 const tail=digits.slice(-fraction.length).replace(/0+$/,'');
 return {unit,quantity:digits.slice(0,-fraction.length)+(tail?'.'+tail:'')};
}
