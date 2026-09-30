import type {Pool,PoolClient} from 'pg';
type DB=Pick<Pool|PoolClient,'query'>;
export async function developmentRoundsAvailable(db:DB){return Boolean((await db.query("SELECT to_regclass('digital_development_rounds') AS relation")).rows[0]?.relation);}
export async function developmentDocumentRow(db:DB,sourceId:string,roundNumber?:number){
 const original=(await db.query('SELECT * FROM digital_development_documents WHERE source_id=$1',[sourceId])).rows[0];
 if(!original)return undefined;
 if(!await developmentRoundsAvailable(db))return {...original,round_number:1,latest_round_number:1};
 const latest=(await db.query('SELECT max(round_number)::int AS n FROM digital_development_rounds WHERE source_id=$1',[sourceId])).rows[0].n??1;
 const selected=roundNumber??latest;
 if(selected===1)return {...original,round_number:1,latest_round_number:latest};
 const round=(await db.query('SELECT * FROM digital_development_rounds WHERE source_id=$1 AND round_number=$2',[sourceId,selected])).rows[0];
 if(!round)return undefined;
 const first=(await db.query('SELECT t.task_id FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) WHERE a.source_id=$1 AND t.route_version=$2 ORDER BY t.created_at,t.task_id LIMIT 1',[sourceId,selected])).rows[0];
 return {...original,document:round.document,version:round.document_version,published_at:round.published_at,task_id:first?.task_id??null,round_number:selected,latest_round_number:latest,revision:round};
}
