import type {Pool,PoolClient} from 'pg';
import type {DevelopmentDocument,DevelopmentPublishedVersions} from '@dx-rework/contracts/digital-development';
import {developmentRoundsAvailable} from './development-round-repository.js';
import {developmentAmendmentsAvailable} from './development-amendment-repository.js';

type Database=Pick<Pool|PoolClient,'query'>;
export type DevelopmentDocumentSnapshot={
 sourceId:string;roundNumber:number;documentVersion:number;document:DevelopmentDocument;
 metadataRecord:Record<string,unknown>;
};

/** The caller must authorize the original source first. These are immutable
 * publication rows, never the effective/current views or an unpublished draft.
 * A missing version has no fallback to another round or to the latest revision.
 */
export async function developmentDocumentSnapshot(db:Database,sourceId:string,roundNumber:number,documentVersion:number):Promise<DevelopmentDocumentSnapshot|undefined>{
 if(!Number.isSafeInteger(roundNumber)||roundNumber<1||!Number.isSafeInteger(documentVersion)||documentVersion<1)return undefined;
 const [rounds,amendments]=await Promise.all([developmentRoundsAvailable(db),developmentAmendmentsAvailable(db)]);
 const parts=[`SELECT d.document,to_jsonb(d) AS metadata_record
  FROM digital_development_documents d WHERE d.source_id=$1 AND $2::integer=1 AND d.version=$3 AND d.status='published'`];
 if(rounds)parts.push(`SELECT r.document,to_jsonb(r) AS metadata_record
  FROM digital_development_rounds r WHERE r.source_id=$1 AND r.round_number=$2 AND r.document_version=$3`);
 if(amendments)parts.push(`SELECT a.document,to_jsonb(a) AS metadata_record
  FROM digital_development_amendments a WHERE a.source_id=$1 AND a.round_number=$2 AND a.document_version=$3`);
 const {rows}=await db.query<{document:DevelopmentDocument;metadata_record:Record<string,unknown>}>(parts.join('\nUNION ALL\n'),[sourceId,roundNumber,documentVersion]);
 if(rows.length>1)throw new Error('开发单所选轮次与资料版本存在冲突，未读取其他版本');
 const row=rows[0];
 return row?{sourceId,roundNumber,documentVersion,document:row.document,metadataRecord:row.metadata_record}:undefined;
}

/** Membership supplements the original attachment authorization; it does not
 * grant download rights. Material sample images must also be in document.files.
 */
export function developmentSnapshotContainsFile(snapshot:DevelopmentDocumentSnapshot,attachmentId:string){
 return snapshot.document.files.some(file=>file.attachmentId===attachmentId);
}

/** Metadata only. Filtering precedes the total/page in one statement; document
 * bodies and attachments are fetched only after a concrete version is selected.
 */
export async function developmentPublishedVersions(db:Database,sourceId:string,page:number,q:string):Promise<DevelopmentPublishedVersions>{
 const [rounds,amendments]=await Promise.all([developmentRoundsAvailable(db),developmentAmendmentsAvailable(db)]);
 const parts=[`SELECT 1 AS round_number,d.version AS document_version,d.published_at,NULL::text AS reason,'initial' AS publication_kind
  FROM digital_development_documents d WHERE d.source_id=$1 AND d.status='published'`];
 if(rounds)parts.push(`SELECT r.round_number,r.document_version,r.published_at,NULL::text AS reason,'round' AS publication_kind
  FROM digital_development_rounds r WHERE r.source_id=$1`);
 if(amendments)parts.push(`SELECT a.round_number,a.document_version,a.published_at,a.reason,'amendment' AS publication_kind
  FROM digital_development_amendments a WHERE a.source_id=$1`);
 const row=(await db.query<{total:number;items:DevelopmentPublishedVersions['items']}>(`WITH published AS (${parts.join('\nUNION ALL\n')}),
  matching AS (SELECT * FROM published WHERE $2::text='' OR strpos(lower('开发单 第'||round_number||'轮 资料版本 '||document_version||' '||COALESCE(reason,'')),lower($2))>0),
  chosen AS (SELECT * FROM matching ORDER BY document_version DESC,round_number DESC,publication_kind LIMIT 15 OFFSET $3)
  SELECT (SELECT count(*)::integer FROM matching) AS total,
   COALESCE(jsonb_agg(jsonb_build_object('roundNumber',round_number,'documentVersion',document_version,'publishedAt',published_at,'reason',reason)
    ORDER BY document_version DESC,round_number DESC,publication_kind),'[]'::jsonb) AS items FROM chosen`,[sourceId,q,(page-1)*15])).rows[0]!;
 return {sourceId,page,pageSize:15,total:row.total,items:row.items};
}
