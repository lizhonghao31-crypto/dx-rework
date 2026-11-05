import type {Pool,PoolClient} from 'pg';
import type {PublishedProductionBasis} from '@dx-rework/contracts/bulk-preparation';
/** Caller authorizes the original order. References only; source/file readers
 * still authorize independently. Never selects a replacement latest artifact. */
export async function publishedProductionBasis(db:Pick<Pool|PoolClient,'query'>,orderId:string,instruction:Record<string,unknown>|undefined,nativeBasis:boolean,sourceReadable:boolean):Promise<PublishedProductionBasis|null>{
 if(!instruction||!Number.isSafeInteger(instruction.version)||Number(instruction.version)<1)return null;
 const snapshot=instruction.order_snapshot as {sourceId?:unknown}|undefined;
 const frozen=nativeBasis&&sourceReadable?(await db.query(`SELECT artifact.artifact_set_id,artifact.version,artifact.source_id,artifact.round_number,artifact.scope_ref
  FROM digital_instruction_preparation_bases basis JOIN digital_development_artifact_versions artifact
   ON artifact.artifact_set_id::text=basis.basis_json->'artifact'->>'id' AND artifact.version::text=basis.basis_json->'artifact'->>'version'
  WHERE basis.production_order_id=$1 AND basis.instruction_version=$2`,[orderId,instruction.version])).rows[0]:null;
 return {instructionVersion:Number(instruction.version),sourceId:sourceReadable&&typeof snapshot?.sourceId==='string'?snapshot.sourceId:null,
  sourceRound:Number.isSafeInteger(instruction.source_round)&&Number(instruction.source_round)>0?Number(instruction.source_round):null,
  publishedAt:instruction.published_at?new Date(instruction.published_at as string|Date).toISOString():null,
  technicalArtifact:frozen?{id:frozen.artifact_set_id,version:Number(frozen.version),sourceId:frozen.source_id,roundNumber:Number(frozen.round_number),scopeRef:frozen.scope_ref}:null,technicalBasisState:typeof snapshot?.sourceId==='string'&&!sourceReadable?'restricted':frozen?'recorded':'missing'};
}
