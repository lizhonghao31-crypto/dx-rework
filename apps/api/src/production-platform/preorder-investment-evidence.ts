import type {DevelopmentMaterial} from '@dx-rework/contracts/digital-development';
import {preparationInvestmentRowKey,type PreparationMaterialFact,type PreorderInvestmentApplicability} from '@dx-rework/contracts/production-readiness';
import {preorderApplicabilityProofMatches,preorderDemandInUnit,preorderInvestmentApplicability,recoverPreorderHandedMaterial} from './preorder-investment-applicability.js';
import type {PreorderApplicabilityProof} from './preorder-investment-applicability.js';
import type {Pool,PoolClient} from 'pg';
import {createHash} from 'node:crypto';
import {warehouseMaterialBalance,warehouseReceiptBatches} from './warehouse-material-balance.js';

const sha=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const originalMaterialFingerprint=(material:DevelopmentMaterial)=>sha([material.materialId,material.category,material.name,material.quantity,
 material.color,material.specification,material.supplier,material.width,material.weight,material.composition]);
export const PREORDER_APPLICABILITY_EVENT='preparation_preorder_original_material_confirmed';

export function originalPreorderDemandBalance(requested:string,unit:string,quantities:readonly {unit:string;quantity:number}[]){
 const actual=warehouseReceiptBatches(unit,quantities.map((row,index)=>({id:String(index),quantity:{unit:row.unit,quantity:String(row.quantity)}})));
 const remaining=warehouseMaterialBalance({unit,invested:{unit,quantity:requested},received:actual,
  productionRequired:null,usableAfterOccupancy:null,dispatchRequired:null,dispatched:null}).procurementRemaining;
 return actual&&remaining!==null?{requested,originallyRecorded:actual.quantity,remaining,unit}:null;
}

export function preorderApplicationBasis(sourceId:string,roundNumber:number,sourceVersion:number,handover:PreparationMaterialFact,
 investment:PreparationMaterialFact,material:DevelopmentMaterial){
 const original=classifyPreorderInvestmentMaterial(handover,investment,material,false);
 if(!original)return null;
 const basis={sourceId,roundNumber,sourceVersion,materialId:material.materialId,handover:{recordId:handover.recordId,version:handover.version},
  investment:{recordId:investment.recordId,version:investment.preorderApplicabilityAnchorVersion??investment.version},beforeFingerprint:original.originalFingerprint,
  afterFingerprint:originalMaterialFingerprint(material)};
 return {basis,decision:original.decision,quantities:original.quantities,requested:original.requested,unit:original.unit};
}

/** Derive the current association without ever copying a purchase or receipt.
 * Use the original physical fingerprints by reference, per item. Unproved or
 * replaced items never hide an unrelated physical quantity. */
export function projectPreorderInvestmentApplicability(handover:PreparationMaterialFact,investment:PreparationMaterialFact|undefined,
 document:{version:number;roundNumber:number;materials:readonly DevelopmentMaterial[]},proofs:readonly PreorderApplicabilityProof[]):PreorderInvestmentApplicability|undefined{
 const basis=handover.investmentScopeBasis;
 if(!basis?.preorder||handover.resource.kind!=='source'||handover.state!=='ready')return undefined;
 const originals=basis.materialFingerprints,entries:Record<string,string>={},revisions:string[]=[];
 const quantityDemand:NonNullable<PreorderInvestmentApplicability['quantityDemand']>={};
 const required=document.materials.filter(material=>material.name.trim()&&material.quantity.trim());
 for(const material of required){
  const before=originals[material.materialId];
  const snapshots=handover.handoverMaterials?.filter(snapshot=>snapshot.materialId===material.materialId)??[];
  if(!before||snapshots.length!==1||required.filter(row=>row.materialId===material.materialId).length!==1)continue;
  const snapshot=snapshots[0]!,after=originalMaterialFingerprint(material);
  if(before===after&&snapshot.supplierId===material.supplierReference?.supplierId&&
      (snapshot.quantityUnit??'')===(material.quantityUnit??'')&&(snapshot.garmentColor??'')===(material.garmentColor??'')){
   entries[material.materialId]=before;continue;
  }
  if(!investment)continue;
  const change=preorderApplicationBasis(handover.resource.id,document.roundNumber,document.version,handover,investment,material);
  if(!change)continue;
  let decision=change.decision;
  if(decision.state==='needs_same_material_proof'){
   const proof=proofs.find(proof=>preorderApplicabilityProofMatches(proof,change.basis));
   if(!proof)continue;
   revisions.push(sha([proof.sourceVersion,proof.materialId,proof.actorId,proof.confirmedAt,proof.sameMaterialEvidenceIds]));
   const proven=classifyPreorderInvestmentMaterial(handover,investment,material,true);
   if(!proven)continue;
   decision=proven.decision;
  }
  if(decision.state==='quantity_amendment'){
   const {unit,requested}=change;
   const balance=originalPreorderDemandBalance(requested,unit,change.quantities);
   if(!balance)continue;
   // Preserve the current real total and show only the genuinely unfilled
   // requirement. A reduction never overwrites an actual recorded excess.
   quantityDemand[material.materialId]=balance;
  }else if(decision.state!=='unchanged'&&decision.state!=='descriptive_fill')continue;
  entries[material.materialId]=before;
 }
 return {sourceVersion:document.version,roundNumber:document.roundNumber,originalFingerprints:entries,basisRevisions:revisions,
  ...(Object.keys(quantityDemand).length?{quantityDemand}:{}),
  full:required.length>0&&required.length===Object.keys(entries).length&&basis.materialIds.length===required.length};
}

export async function readPreorderApplicabilityProofs(db:Pick<Pool|PoolClient,'query'>,sourceIds:readonly string[]){
 if(!sourceIds.length)return [];
 return (await db.query<{proof:PreorderApplicabilityProof}>(`SELECT recorded.after_state||CASE WHEN release.version IS NOT NULL
   THEN jsonb_build_object('technicalReleaseVersion',release.version) ELSE '{}'::jsonb END AS proof
  FROM audit_events recorded
  LEFT JOIN LATERAL (SELECT (a.after_state->>'documentVersion')::int AS version FROM audit_events a
   WHERE a.entity_type='digital_development' AND a.entity_id=recorded.entity_id AND a.action='digital_development_preorder_technical_released'
   AND recorded.after_state->>'roundNumber'='1' AND (a.after_state->>'documentVersion')::int=(recorded.after_state->>'sourceVersion')::int+1
   ORDER BY a.created_at DESC,a.id DESC LIMIT 1) release ON true
  WHERE recorded.entity_type='digital_preparation' AND recorded.entity_id=ANY($1::text[]) AND recorded.action=$2
  AND jsonb_typeof(recorded.after_state->'sameMaterialEvidenceIds')='array'
  AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(recorded.after_state->'sameMaterialEvidenceIds') item(id)
   LEFT JOIN attachments a ON a.attachment_id::text=item.id AND a.status='ready' WHERE a.attachment_id IS NULL)
  ORDER BY recorded.created_at DESC,recorded.id`,[sourceIds,PREORDER_APPLICABILITY_EVENT])).rows.map(row=>row.proof);
}

/** Classify one exact physical preorder allocation. The independent proof is
 * evaluated by the authorized recording command, never inferred from names. */
export function classifyPreorderInvestmentMaterial(handover:PreparationMaterialFact,investment:PreparationMaterialFact,
 current:DevelopmentMaterial,sameMaterialProof:boolean){
 const basis=handover.investmentScopeBasis,old=basis?.materialFingerprints[current.materialId];
 if(!old||!basis?.preorder||handover.scopeRef!=='whole'||investment.scopeRef!=='whole'||handover.resource.kind!=='source'||
  investment.resource.kind!=='source'||investment.resource.id!==handover.resource.id||!investment.valid||
  !['partial','ready'].includes(investment.state)||investment.investmentScopeBasis?.materialFingerprints[current.materialId]!==old)return null;
 const captured=handover.handoverMaterials?.filter(row=>row.materialId===current.materialId)??[];
 if(captured.length!==1)return null;
 const snapshot=captured[0]!;
 if(!snapshot.category||snapshot.supplier===undefined||!snapshot.supplierId||!current.supplierReference)return null;
 if((snapshot.garmentColor??'')!==(current.garmentColor??''))return null;
 const previous=recoverPreorderHandedMaterial({...snapshot,category:snapshot.category,supplier:snapshot.supplier},current,old);
 if(!previous)return null;
 const quantities=investment.quantities.filter(row=>row.materialId===current.materialId);
 if(!quantities.length||quantities.some(row=>(investment.investmentQuantityOccurrences?.[preparationInvestmentRowKey(row)]??
  (quantities.length===1?investment.investmentMaterialOccurrences?.[current.materialId]:undefined))?.fingerprint!==old))return null;
 const unit=quantities[0]!.unit;
 if(!unit||quantities.some(row=>row.unit!==unit))return null;
 const poLineIds=quantities.flatMap(row=>row.lineId?[row.lineId]:[]);
 if(new Set(poLineIds).size!==poLineIds.length||quantities.length!==poLineIds.length&&quantities.length!==1)return null;
 const oldQty=preorderDemandInUnit(previous.quantity,unit,snapshot.quantityUnit||undefined);
 const currentQty=preorderDemandInUnit(current.quantity,unit,current.quantityUnit||undefined);
 if(!oldQty||!currentQty)return null;
 return {originalFingerprint:old,materialId:current.materialId,quantities,requested:currentQty,unit,decision:preorderInvestmentApplicability(
  {...previous,supplierId:snapshot.supplierId,poLineIds,requested:oldQty,unit},
  {...current,supplierId:current.supplierReference.supplierId,poLineIds,requested:currentQty,unit},sameMaterialProof)};
}
