import {noteCommentTimeAvailability} from './development-comment-time.js';
import {createHash} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import type {DevelopmentDocument} from '@dx-rework/contracts/digital-development';
import {DEVELOPMENT_TECHNICAL_RULE,TechnicalArtifactBodySchema,technicalMakingDocument,type EffectiveTechnicalEvidence,type TechnicalArtifact} from '@dx-rework/contracts/digital-development-technical';
import {developmentDocumentRow} from './development-round-repository.js';

export type TechnicalDB=Pick<Pool|PoolClient,'query'>;
export async function technicalEvidenceAvailable(db:TechnicalDB){const row=(await db.query("SELECT to_regclass('digital_development_technical_enrollments') AS relation,to_regclass('digital_development_comment_times') AS comment_times")).rows[0];noteCommentTimeAvailability(db,Boolean(row?.comment_times));return Boolean(row?.relation);}
export async function technicalEnrollment(db:TechnicalDB,sourceId:string){return await technicalEvidenceAvailable(db)?(await db.query('SELECT * FROM digital_development_technical_enrollments WHERE source_id=$1',[sourceId])).rows[0]??null:null;}
export function technicalDocumentFingerprint(d:DevelopmentDocument):string {
 // Packing wording and commercial prices are not a new technical revision.
 const value={unit:d.unit,sizes:d.sizes,measurements:d.measurements,craft:d.craft,washing:d.washing,
  interlining:d.interlining,placketInterlining:d.placketInterlining,stitchDensity:d.stitchDensity,
  materials:d.materials.map(m=>({id:m.materialId,category:m.category,name:m.name,specification:m.specification,width:m.width,weight:m.weight,composition:m.composition,color:m.color})).sort((a,b)=>a.id.localeCompare(b.id))};
 return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
type ArtifactRow={artifact_set_id:string;version:number;source_id:string;round_number:number;scope_ref:string;task_id:string;document_version:number;status:'draft'|'published';body:unknown;created_by:string;created_at:string|Date};
export function technicalArtifactDto(row:ArtifactRow):TechnicalArtifact {
 return {artifactSetId:row.artifact_set_id,version:row.version,sourceId:row.source_id,roundNumber:row.round_number,scopeRef:row.scope_ref,
  taskId:row.task_id,documentVersion:row.document_version,status:row.status,body:TechnicalArtifactBodySchema.parse(row.body),createdBy:row.created_by,createdAt:new Date(row.created_at).toISOString()};
}
export async function publishedTechnicalArtifact(db:TechnicalDB,sourceId:string,round:number,scope='整款'){
 if(!await technicalEvidenceAvailable(db))return null;
 const own=(await db.query(`SELECT v.* FROM digital_development_artifact_heads h JOIN digital_development_artifact_versions v
  ON v.artifact_set_id=h.artifact_set_id AND v.version=h.published_version WHERE h.source_id=$1 AND h.round_number=$2 AND h.scope_ref=$3`,[sourceId,round,scope])).rows[0];
 if(own)return {row:own,artifact:technicalArtifactDto(own)};
 const inherited=(await db.query(`SELECT v.*,i.adopted_document_fingerprint FROM digital_development_artifact_inheritances i JOIN digital_development_artifact_versions v
  ON v.artifact_set_id=i.artifact_set_id AND v.version=i.artifact_version WHERE i.source_id=$1 AND i.round_number=$2 AND i.scope_ref=$3`,[sourceId,round,scope])).rows[0];
 return inherited?{row:{...inherited,document_fingerprint:inherited.adopted_document_fingerprint},artifact:{...technicalArtifactDto(inherited),inheritedFrom:{sourceId:inherited.source_id,roundNumber:inherited.round_number}}}:null;
}
/** Measurement actions use the technical table, while the original design document remains immutable. */
export async function technicalMeasurementDocument(db:TechnicalDB,sourceId:string,round:number,document:DevelopmentDocument){
 if(!await technicalEnrollment(db,sourceId))return {document,artifactRef:null};
 const current=await publishedTechnicalArtifact(db,sourceId,round);if(!current)return null;
 const table=current.artifact.body.baseSizeTable;
 return {document:technicalMakingDocument(document,table),artifactRef:{id:current.artifact.artifactSetId,version:current.artifact.version}};
}

/** Canonical technical validity. Consumers may add their own material/action gates, never replace this decision. */
export async function effectiveTechnicalEvidence(db:TechnicalDB,sourceId:string,round:number,scope='整款',targetCustomerCode?:string):Promise<EffectiveTechnicalEvidence>{
 const result:EffectiveTechnicalEvidence={sourceId,roundNumber:round,scopeRef:scope,revision:'',state:'unknown',reasonCodes:[],customerCode:null,finalCommentRef:null,reviewRef:null,artifactRef:null};
 const enrolled=await technicalEnrollment(db,sourceId);
 if(!enrolled){result.reasonCodes=['LEGACY_TECHNICAL_BASIS_UNKNOWN'];result.revision=`legacy:${sourceId}:${round}:${scope}`;return result;}
 const comment=(await db.query(`SELECT * FROM digital_development_final_comments WHERE source_id=$1 AND round_number=$2 AND scope_ref=$3 AND is_final ORDER BY version DESC LIMIT 1`,[sourceId,round,scope])).rows[0];
 const current=await publishedTechnicalArtifact(db,sourceId,round,scope);
 const document=await developmentDocumentRow(db,sourceId,round);
 const review=comment?(await db.query(`SELECT q.review_id,q.task_id,q.final_comment_id,r.version,r.decision,r.artifact_set_id,r.artifact_version
  FROM digital_development_size_review_requests q LEFT JOIN digital_development_size_review_results r USING(review_id)
  WHERE q.final_comment_id=$1`,[comment.comment_id])).rows[0]:null;
 if(comment){result.finalCommentRef={id:comment.comment_id,version:comment.version};result.customerCode=comment.customer_code;}
 if(review)result.reviewRef={id:review.review_id,version:review.version??1};
 if(current)result.artifactRef={id:current.artifact.artifactSetId,version:current.artifact.version};
 if(!current)result.reasonCodes.push('MISSING_TECHNICAL_ARTIFACT');
 else {
  if(!document?.document||current.row.document_fingerprint!==technicalDocumentFingerprint(document.document))result.reasonCodes.push('TECHNICAL_SOURCE_CHANGED');
  const files=current.artifact.body.pltAttachmentIds;
  const ready=(await db.query("SELECT count(*)::int AS n FROM attachments WHERE attachment_id=ANY($1::uuid[]) AND status='ready' AND mime_type='application/octet-stream'",[files])).rows[0].n;
  if(!files.length||ready!==files.length)result.reasonCodes.push('TECHNICAL_FILE_UNAVAILABLE');
 }
 if(!comment)result.reasonCodes.push('NO_FINAL_CUSTOMER_COMMENT');
 else if(comment.decision!=='approved')result.reasonCodes.push('CUSTOMER_CHANGES_REQUIRED');
 if(comment&&targetCustomerCode!==undefined&&comment.customer_code!==targetCustomerCode)result.reasonCodes.push('CUSTOMER_BASIS_MISMATCH');
 if(!review?.version)result.reasonCodes.push('SIZE_REVIEW_PENDING');
 else if(!current||review.artifact_set_id!==current.artifact.artifactSetId||review.artifact_version!==current.artifact.version)result.reasonCodes.push('REVIEW_ARTIFACT_SUPERSEDED');
 result.state=!result.reasonCodes.length?'effective':result.reasonCodes.includes('REVIEW_ARTIFACT_SUPERSEDED')||result.reasonCodes.includes('TECHNICAL_SOURCE_CHANGED')?'superseded':result.reasonCodes.some(r=>['NO_FINAL_CUSTOMER_COMMENT','CUSTOMER_CHANGES_REQUIRED','CUSTOMER_BASIS_MISMATCH'].includes(r))?'pending_customer':result.reasonCodes.includes('SIZE_REVIEW_PENDING')?'pending_review':'unknown';
 result.revision=createHash('sha256').update(JSON.stringify({rule:DEVELOPMENT_TECHNICAL_RULE,sourceId,round,scope,comment:result.finalCommentRef,review:result.reviewRef,artifact:result.artifactRef,reasons:result.reasonCodes})).digest('hex');
 return result;
}

/** Reuse only a real published, technically unchanged original group. No file is uploaded again. */
export async function inheritTechnicalArtifact(db:TechnicalDB,actorId:string,sourceId:string,round:number,parentSourceId:string,parentRound:number,at:string){
 if(!await technicalEnrollment(db,sourceId))return;
 const parent=await publishedTechnicalArtifact(db,parentSourceId,parentRound),current=await developmentDocumentRow(db,sourceId,round);
 if(!parent||!current?.document)return;
 const fingerprint=technicalDocumentFingerprint(current.document),original=await developmentDocumentRow(db,parentSourceId,parentRound);
 if(parent.row.document_fingerprint!==fingerprint&&(!original?.document||technicalDocumentFingerprint(technicalMakingDocument(original.document,parent.artifact.body.baseSizeTable))!==fingerprint))return;
 if(sourceId!==parentSourceId&&!(await db.query('SELECT 1 FROM digital_development_revision_sources WHERE source_id=$1 AND parent_source_id=$2',[sourceId,parentSourceId])).rowCount)return;
 await db.query(`INSERT INTO digital_development_artifact_inheritances(source_id,round_number,scope_ref,artifact_set_id,artifact_version,created_by,created_at,adopted_document_fingerprint)
  VALUES($1,$2,'整款',$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,[sourceId,round,parent.artifact.artifactSetId,parent.artifact.version,actorId,at,fingerprint]);
 if(sourceId!==parentSourceId)for(const id of parent.artifact.body.pltAttachmentIds)
  await db.query(`INSERT INTO digital_development_inherited_files(source_id,attachment_id,original_source_id,inherited_by) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,[sourceId,id,parent.artifact.sourceId,actorId]);
}
