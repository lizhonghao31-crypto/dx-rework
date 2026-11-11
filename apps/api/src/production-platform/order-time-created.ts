import type {PoolClient} from 'pg';
import type {BusinessTimeScope} from '@dx-rework/domain/business-clock';
import {validateBusinessTime} from '@dx-rework/domain/business-clock';
/** Present only for a real native creation registered by the new command.
 * Neither adoption time nor the database/audit registration clock replaces it. */
export async function orderTimeCreated(db:Pick<PoolClient,'query'>,resource:BusinessTimeScope){
 const row=(await db.query(`SELECT created_business_time,creation_event_ref FROM digital_order_time_subjects WHERE resource_kind=$1 AND ${resource.kind==='source'?'source_id':'production_order_id'}=$2`,[resource.kind,resource.id])).rows[0];
 return row?{at:validateBusinessTime(row.created_business_time).now,evidence:String(row.creation_event_ref)}:null;
}
