import {comparePositiveMaterialQuantities} from './warehouse-material-balance.js';
import {createHash} from 'node:crypto';

const fillable=['specification','width','weight','composition'] as const;
type Description=Record<(typeof fillable)[number],string>;
export type PreorderMaterialScope=Description&{
 materialId:string;supplierId:string|null;category:string;name:string;color:string;
 unit:string;requested:string;poLineIds:readonly string[]|null;
};

/** Pure applicability decision. The repository must supply the original actual
 * purchase identity, immutable material basis and a separately verified proof
 * before accepting a descriptive fill. This never rewrites an event or quantity. */
export function preorderInvestmentApplicability(before:PreorderMaterialScope,after:PreorderMaterialScope,sameMaterialProof:boolean){
 if(!before.materialId||!after.materialId||!before.supplierId||!after.supplierId||!before.unit||!after.unit||
    before.poLineIds===null||after.poLineIds===null)return {state:'needs_identity' as const};
 if(before.materialId!==after.materialId||before.supplierId!==after.supplierId||
    before.category!==after.category||before.name!==after.name||before.color!==after.color)return {state:'replacement' as const};
 if(before.unit!==after.unit||JSON.stringify([...before.poLineIds].sort())!==JSON.stringify([...after.poLineIds].sort()))
  return {state:'needs_identity' as const};

 const filled=fillable.filter(field=>before[field].trim()===''&&after[field].trim()!=='');
 if(fillable.some(field=>before[field]!==after[field]&&!filled.includes(field)))return {state:'replacement' as const};
 const delta=comparePositiveMaterialQuantities({quantity:after.requested,unit:after.unit},{quantity:before.requested,unit:before.unit});
 if(delta===null)return {state:'needs_identity' as const};
 if(filled.length&&!sameMaterialProof)return {state:'needs_same_material_proof' as const,filled};
 if(delta!==0)return {state:'quantity_amendment' as const,direction:delta>0?'increase':'decrease',filled};
 return filled.length?{state:'descriptive_fill' as const,filled}:{state:'unchanged' as const};
}

export type PreorderApplicabilityRef={recordId:string;version:number};
export type PreorderApplicabilityProof={
    sourceId:string;roundNumber:number;sourceVersion:number;materialId:string;
    handover:PreorderApplicabilityRef;investment:PreorderApplicabilityRef;
    beforeFingerprint:string;afterFingerprint:string;actorId:string;confirmedAt:string;
    sameMaterialEvidenceIds:readonly string[];
    technicalReleaseVersion?:number;
};

/** A recorded confirmation covers one exact change and one purchase version.
 * Returning to an older fingerprint, another round or a corrected entry does
 * not silently re-use the confirmation. */
export function preorderApplicabilityProofMatches(proof:PreorderApplicabilityProof,subject:Omit<PreorderApplicabilityProof,
 'actorId'|'confirmedAt'|'sameMaterialEvidenceIds'|'technicalReleaseVersion'>){
 return proof.sourceId===subject.sourceId&&proof.roundNumber===subject.roundNumber&&
  (proof.sourceVersion===subject.sourceVersion||proof.technicalReleaseVersion===subject.sourceVersion)&&
  proof.materialId===subject.materialId&&proof.beforeFingerprint===subject.beforeFingerprint&&proof.afterFingerprint===subject.afterFingerprint&&
  proof.handover.recordId===subject.handover.recordId&&proof.handover.version===subject.handover.version&&
  proof.investment.recordId===subject.investment.recordId&&proof.investment.version===subject.investment.version&&
  Number.isFinite(Date.parse(proof.confirmedAt))&&proof.sameMaterialEvidenceIds.length>0;
}

export type PreorderMaterialDescription=Description&{materialId:string;category:string;name:string;color:string;quantity:string;supplier:string};
type MaterialDescription=PreorderMaterialDescription;
type Snapshot=Pick<MaterialDescription,'category'|'name'|'color'|'quantity'|'supplier'|'specification'>&
 {materialId?:string;supplierId?:string;width?:string;weight?:string;composition?:string};

/** Historic handovers did not keep width, weight and composition separately.
 * For this narrow decision, the immutable row hash can prove that each of
 * those fields was already equal or originally blank. Any nonempty older value
 * different from the current value must fail, even if today's operator claims
 * this was a fill. The old hash and document are never edited. */
export function recoverPreorderHandedMaterial(stored:Snapshot,current:MaterialDescription,fingerprint:string):MaterialDescription|null{
 if(!stored.materialId||stored.materialId!==current.materialId)return null;
 const options=(known:string|undefined,next:string)=>known!==undefined?[known]:next?['',next]:[''];
 for(const width of options(stored.width,current.width))for(const weight of options(stored.weight,current.weight))
  for(const composition of options(stored.composition,current.composition)){
   const row=[stored.materialId,stored.category,stored.name,stored.quantity,stored.color,stored.specification,stored.supplier,width,weight,composition];
   if(createHash('sha256').update(JSON.stringify(row)).digest('hex')===fingerprint)
    return {...stored,materialId:stored.materialId,width,weight,composition};
  }
 return null;
}

export function preorderDemandInUnit(value:string,unit:string,explicitUnit?:string){
 const parsed=/^(\d+(?:\.\d+)?)\s*(.*?)$/.exec(value.trim());
 if(!parsed||!unit||explicitUnit&&unit!==explicitUnit||parsed[2]&&parsed[2]!==unit||!explicitUnit&&!parsed[2])return null;
 return parsed[1]??null;
}
