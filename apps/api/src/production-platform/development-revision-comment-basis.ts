import type {PoolClient} from 'pg';
import {DevelopmentRevisionCommentRefSchema,type DevelopmentRevisionCommentRef,type TechnicalFinalComment,type DevelopmentCommentRevisionLink} from '@dx-rework/contracts/digital-development-technical';

/** Internal lookup for an already authorized original comment. Callers still
 * have to check the current actor and real parent/root document relationship.
 * This does not whitelist any attachment for display or download. */
export async function readDevelopmentRevisionCommentBasis(db:Pick<PoolClient,'query'>,reference:DevelopmentRevisionCommentRef){
 const ref=DevelopmentRevisionCommentRefSchema.parse(reference);
 const row=(await db.query<{text_value:string;evidence_refs:string[];customer_code:string|null;is_final:boolean;decision:TechnicalFinalComment['decision'];recorded_at:Date|string}>(`SELECT text_value,evidence_refs,customer_code,is_final,decision,recorded_at
  FROM digital_development_final_comments WHERE source_id=$1 AND round_number=$2 AND scope_ref=$3 AND comment_id=$4 AND version=$5`,
 [ref.sourceId,ref.roundNumber,ref.scopeRef,ref.commentId,ref.version])).rows[0];
 if(!row)return null;
 return {ref,text:row.text_value,evidenceRefs:row.evidence_refs,customerCode:row.customer_code,final:row.is_final,decision:row.decision,recordedAt:row.recorded_at};
}

export async function developmentRevisionCommentAdoptionReady(db:Pick<PoolClient,'query'>){
 return Boolean((await db.query("SELECT to_regclass('digital_development_revision_comment_adoptions') AS relation")).rows[0]?.relation);
}

export async function readAdoptedDevelopmentRevisionComment(db:Pick<PoolClient,'query'>,sourceId:string,roundNumber:number){
 if(!await developmentRevisionCommentAdoptionReady(db))return null;
 // Old databases have just the first adoption. A repeated print additionally
 // needs the exact preceding adoption of the same immutable comment.
 const {rows:[selected]}=await db.query<DevelopmentRevisionCommentRef&{sequence:number;previousSourceId:string|null;previousRoundNumber:number|null}>(`SELECT
  a.based_on_source_id AS "sourceId",a.based_on_round AS "roundNumber",a.based_on_scope AS "scopeRef",a.comment_id AS "commentId",a.comment_version AS version,
  COALESCE((to_jsonb(a)->>'adoption_number')::int,1) AS sequence,p.source_id AS "previousSourceId",p.round_number AS "previousRoundNumber"
  FROM digital_development_revision_comment_adoptions a LEFT JOIN digital_development_revision_comment_adoptions p
    ON p.source_id=(to_jsonb(a)->>'previous_source_id')::uuid AND p.round_number=(to_jsonb(a)->>'previous_round_number')::int
    AND p.based_on_source_id=a.based_on_source_id AND p.based_on_round=a.based_on_round AND p.based_on_scope=a.based_on_scope
    AND p.comment_id=a.comment_id AND p.comment_version=a.comment_version
    AND (to_jsonb(p)->>'adoption_number')::int=(to_jsonb(a)->>'adoption_number')::int-1
  WHERE a.source_id=$1 AND a.round_number=$2`,[sourceId,roundNumber]);
 if(!selected)return null;
 const {sequence,previousSourceId,previousRoundNumber,...ref}=selected;
 const original=await readDevelopmentRevisionCommentBasis(db,ref);
 return original?{...original,sequence,previousSourceId,previousRoundNumber}:null;
}

export async function revisionCommentImages(db:Pick<PoolClient,'query'>,original:NonNullable<Awaited<ReturnType<typeof readDevelopmentRevisionCommentBasis>>>){
 if(!original.evidenceRefs.length)return [];
 return (await db.query<{attachmentId:string}>(`SELECT a.attachment_id AS "attachmentId"
  FROM unnest($2::uuid[]) WITH ORDINALITY selected(id,position) JOIN attachments a ON a.attachment_id=selected.id
  WHERE a.entity_type='digital_development' AND a.status='ready' AND a.mime_type IN ('image/jpeg','image/png','image/webp')
  AND (a.entity_id=$1::uuid::text AND EXISTS (SELECT 1 FROM digital_development_attachment_bindings b
   WHERE b.source_id=$1::uuid AND b.attachment_id=a.attachment_id) OR EXISTS (SELECT 1 FROM digital_development_inherited_files f
   WHERE f.source_id=$1::uuid AND f.original_source_id::text=a.entity_id AND f.attachment_id=a.attachment_id))
  ORDER BY selected.position`,[original.ref.sourceId,original.evidenceRefs])).rows;
}

/** The original comment's owning designer can recover the same current target.
 * Adoptions never grant access to other comments, sources or documents. */
export async function developmentCommentRevisionLinks(db:Pick<PoolClient,'query'>,sourceId:string,round:number,scope:string){
 if(!await developmentRevisionCommentAdoptionReady(db))return [];
 return (await db.query<DevelopmentCommentRevisionLink>(`SELECT DISTINCT ON(adoption.comment_id)
   adoption.comment_id AS "commentId",adoption.source_id AS "sourceId",adoption.round_number AS "roundNumber",
   CASE WHEN document.status='published' THEN 'published' ELSE 'draft' END AS status,request.request_id AS "timeRequestId"
  FROM digital_development_revision_comment_adoptions adoption
  JOIN digital_development_documents document ON document.source_id=adoption.source_id
  LEFT JOIN LATERAL(
   SELECT request_id FROM digital_order_time_requests t WHERE t.source_id=adoption.source_id
    AND t.operation_json->>'kind'='development_publish' AND t.state IN ('pending','needs_designer','returned')
   ORDER BY t.version DESC,t.request_id LIMIT 1
  ) request ON document.status<>'published'
  WHERE adoption.based_on_source_id=$1 AND adoption.based_on_round=$2 AND adoption.based_on_scope=$3
  ORDER BY adoption.comment_id,COALESCE((to_jsonb(adoption)->>'adoption_number')::int,1) DESC`,[sourceId,round,scope])).rows;
}

export async function readRepeatedDevelopmentCommentIntent(db:Pick<PoolClient,'query'>,sourceId:string,round:number){
 if(!await developmentRevisionCommentAdoptionReady(db))return null;
 const {rows:[record]}=await db.query<DevelopmentRevisionCommentRef&{previousRoundNumber:number}>(`SELECT based_on_source_id AS "sourceId",
  based_on_round AS "roundNumber",based_on_scope AS "scopeRef",comment_id AS "commentId",comment_version AS version,round_number AS "previousRoundNumber"
  FROM digital_development_revision_comment_adoptions a WHERE source_id=$1 AND round_number<=$2 AND to_jsonb(a)->>'adoption_number' IS NOT NULL
  ORDER BY round_number DESC LIMIT 1`,[sourceId,round]);
 if(!record)return null;
 const {previousRoundNumber,...ref}=record,basis=await readDevelopmentRevisionCommentBasis(db,ref);
 const latest=(await developmentCommentRevisionLinks(db,ref.sourceId,ref.roundNumber,ref.scopeRef)).find(row=>row.commentId===ref.commentId);
 return basis&&latest?{ref,text:basis.text,evidenceRefs:basis.evidenceRefs,previousRoundNumber,latest}:null;
}
