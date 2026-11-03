import type {Pool,PoolClient} from 'pg';

export type BulkPreshrinkRequirement = '需要预缩' | '无需预缩';

/** An existing preparation owns its frozen choice. A later draft/publication cannot replace it. */
export function resolveBulkPreshrinkRequirement(
 preparation: {preshrink: unknown} | null | undefined,
 publishedInstruction?: {preshrink?: unknown} | null,
): BulkPreshrinkRequirement | null {
 const choice = preparation ? preparation.preshrink : publishedInstruction?.preshrink;
 return choice === '需要预缩' || choice === '无需预缩' ? choice : null;
}

type Database=Pick<Pool|PoolClient,'query'>;
type Preparation={preparation_id?:string;preshrink:unknown};

/** Only the append-only, specifically authorized correction can override a frozen prep. */
export async function readBulkPreshrinkRequirement(db:Database,preparation:Preparation|null|undefined,publishedInstruction?:{preshrink?:unknown}|null){
 const original=resolveBulkPreshrinkRequirement(preparation,publishedInstruction);
 if(preparation?.preparation_id&&original==='需要预缩'&&(await db.query("SELECT to_regclass('digital_bulk_preshrink_corrections') AS relation")).rows[0]?.relation){
  const correction=(await db.query('SELECT correction_id,preshrink_task_id FROM digital_bulk_preshrink_corrections WHERE preparation_id=$1',[preparation.preparation_id])).rows[0];
  if(correction)return {requirement:'无需预缩' as const,correctionId:correction.correction_id as string,retiredTaskId:correction.preshrink_task_id as string};
 }
 return {requirement:original,correctionId:null,retiredTaskId:null};
}

/** The same correction provenance defines the excluded task denominator in both readers. */
export async function retiredBulkPreshrinkTaskIds(db:Database):Promise<string[]>{
 if(!(await db.query("SELECT to_regclass('digital_bulk_preshrink_corrections') AS relation")).rows[0]?.relation)return [];
 return (await db.query('SELECT preshrink_task_id FROM digital_bulk_preshrink_corrections ORDER BY preshrink_task_id')).rows.map(row=>row.preshrink_task_id as string);
}
