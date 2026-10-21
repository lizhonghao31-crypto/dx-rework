import type {Pool,PoolClient} from "pg";
type DB=Pick<Pool|PoolClient,"query">;
export async function developmentAmendmentsAvailable(db:DB):Promise<boolean>{return Boolean((await db.query("SELECT to_regclass('digital_development_amendments') AS relation")).rows[0]?.relation);}
/** Fixed relation names only; old isolated fixtures can still read frozen pre-amendment schemas. */
export async function developmentReadTables(db:DB){
 const amended=await developmentAmendmentsAvailable(db);
 return {amended,current:amended?"digital_development_amended_current_documents":"digital_development_current_documents",documents:amended?"digital_development_effective_documents":"digital_development_documents",rounds:amended?"digital_development_effective_rounds":"digital_development_rounds"};
}
