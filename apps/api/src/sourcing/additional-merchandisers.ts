import type {PoolClient} from 'pg';
type DB=Pick<PoolClient,'query'>;
/** Original single-secondary data remains valid. Native queries also select the
 * complete relationship; older callers may still read the legacy first field.
 */
export async function readAdditionalMerchandiserIds(db:DB,caseId:string):Promise<string[]>{
 return (await db.query<{ids:string[]}>('SELECT sourcing_additional_merchandiser_ids($1) AS ids',[caseId])).rows[0]?.ids??[];
}
export async function bindAdditionalMerchandisers(db:DB,caseId:string,ids:readonly string[]){
 if(!ids.length)return;
 await db.query('INSERT INTO sourcing_case_secondary_merchandisers(sourcing_case_id,user_id,position) SELECT $1,id,position FROM unnest($2::uuid[]) WITH ORDINALITY selected(id,position)',[caseId,[...new Set(ids)]]);
}
