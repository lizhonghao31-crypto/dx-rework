import type {Pool,PoolClient} from "pg";
import type {JourneyDocumentMetadata} from "@dx-rework/contracts/digital-production-journey";
/** Caller has already run the original document reader's authorization. No task owners or guessed timestamps. */
export async function documentMetadata(db:Pick<Pool|PoolClient,"query">,record:Record<string,unknown>|null|undefined):Promise<JourneyDocumentMetadata>{
 const source=record??{},ids=[...new Set([source.created_by,source.updated_by,source.published_by].filter((value):value is string=>typeof value==="string"))];
 const names=new Map<string,string>(ids.length?(await db.query("SELECT id,display_name FROM app_users WHERE id=ANY($1::uuid[])",[ids])).rows.map(row=>[row.id,row.display_name]):[]);
 const at=(value:unknown)=>value instanceof Date?value.toISOString():typeof value==="string"&&Number.isFinite(Date.parse(value))?new Date(value).toISOString():null;
 const by=(value:unknown)=>typeof value==="string"?names.get(value)??null:null;
 return {created:{at:at(source.created_at),by:by(source.created_by)},edited:{at:at(source.updated_at),by:by(source.updated_by)},published:{at:at(source.published_at),by:by(source.published_by)}};
}
