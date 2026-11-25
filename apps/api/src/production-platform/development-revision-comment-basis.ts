import type {PoolClient} from 'pg';
import {DevelopmentRevisionCommentRefSchema,type DevelopmentRevisionCommentRef} from '@dx-rework/contracts/digital-development-technical';

/** Internal lookup for an already authorized original comment. Callers still
 * have to check the current actor and real parent/root document relationship.
 * This does not whitelist any attachment for display or download. */
export async function readDevelopmentRevisionCommentBasis(db:Pick<PoolClient,'query'>,reference:DevelopmentRevisionCommentRef){
 const ref=DevelopmentRevisionCommentRefSchema.parse(reference);
 const row=(await db.query<{text_value:string;evidence_refs:string[];customer_code:string|null;is_final:boolean}>(`SELECT text_value,evidence_refs,customer_code,is_final
  FROM digital_development_final_comments WHERE source_id=$1 AND round_number=$2 AND scope_ref=$3 AND comment_id=$4 AND version=$5`,
 [ref.sourceId,ref.roundNumber,ref.scopeRef,ref.commentId,ref.version])).rows[0];
 if(!row)return null;
 return {ref,text:row.text_value,evidenceRefs:row.evidence_refs,customerCode:row.customer_code,final:row.is_final};
}
