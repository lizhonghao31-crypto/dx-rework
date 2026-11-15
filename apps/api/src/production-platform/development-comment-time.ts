import type {Pool,PoolClient} from 'pg';
import type {z} from 'zod';
import type {CustomerCommentOccurrenceSchema} from '@dx-rework/contracts/digital-development-technical';
import {beijingCalendarDate} from '@dx-rework/contracts/digital-production';
import {isCalendarDate} from '@dx-rework/contracts/series-calendar';
import {ApplicationError} from '../platform/errors.js';
type DB=Pick<Pool|PoolClient,'query'>;
const installed=new WeakMap<object,boolean>();
/** Filled by the existing technical-capability query, avoiding a per-order
 * extra SQL in Journey. Old schema fixtures and inherited sources stay readable. */
export function noteCommentTimeAvailability(db:DB,available:boolean){installed.set(db,available);}
export async function commentTimeColumns(db:DB,alias='c'){
 if(!/^[a-z][a-z0-9_]*$/.test(alias))throw Error('Invalid internal comment alias');
 let available=installed.get(db);
 if(available===undefined){available=Boolean((await db.query("SELECT to_regclass('digital_development_comment_times') AS relation")).rows[0]?.relation);installed.set(db,available);}
 return available?{join:`LEFT JOIN digital_development_comment_times ct ON ct.comment_id=${alias}.comment_id`,columns:`coalesce(ct.occurred_at,${alias}.occurred_at) AS occurred_at,ct.occurred_date::text AS occurred_date,ct.evidence_id AS time_evidence_id,ct.note AS time_note,ct.recorded_at AS time_recorded_at,ct.recorded_by AS time_recorded_by`}
 :{join:'',columns:`${alias}.occurred_at,NULL::text AS occurred_date,NULL::uuid AS time_evidence_id,NULL::text AS time_note,NULL::timestamptz AS time_recorded_at,NULL::uuid AS time_recorded_by`};
}
type TimeRow={occurred_at?:Date|string|null;occurred_date?:string|null;time_evidence_id?:string|null;time_note?:string|null;time_recorded_at?:Date|string|null;time_recorded_by?:string|null};
export function commentTimeDto(row:TimeRow){return {occurredAt:row.occurred_at?new Date(row.occurred_at).toISOString():null,occurredDate:row.occurred_date??null,timeEvidence:row.time_evidence_id?{id:row.time_evidence_id,note:row.time_note!,recordedAt:new Date(row.time_recorded_at!).toISOString(),recordedBy:row.time_recorded_by!}:null};}
export function customerCommentTime(value:z.infer<typeof CustomerCommentOccurrenceSchema>|undefined,legacyAt:string|null,now:Date){
 const occurredAt=value?.precision==='current'?now.toISOString():value?.precision==='instant'?new Date(value.at).toISOString():value===undefined?legacyAt:null;
 const occurredDate=value?.precision==='date'?value.date:null;
 if(occurredDate&&!isCalendarDate(occurredDate))throw new ApplicationError('DEVELOPMENT_TECHNICAL_CONFLICT','客户评语实际发生日期无效',409);
 if(occurredAt&&Date.parse(occurredAt)>now.getTime()||occurredDate&&occurredDate>beijingCalendarDate(now))throw new ApplicationError('DEVELOPMENT_TECHNICAL_CONFLICT','客户评语实际发生时间不能在未来',409);
 return {occurredAt,occurredDate};
}

export async function appendCommentTime(db:DB,actorId:string,id:string,comment:{comment_id:string;source_id:string;round_number:number;scope_ref:string;version:number},value:{occurredAt:string|null;occurredDate:string|null},note:string,recordedAt:string){
 if(!value.occurredAt&&!value.occurredDate)return;
 await db.query(`INSERT INTO digital_development_comment_times(evidence_id,comment_id,source_id,round_number,scope_ref,comment_version,precision,occurred_at,occurred_date,note,recorded_by,recorded_at)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,[id,comment.comment_id,comment.source_id,comment.round_number,comment.scope_ref,comment.version,value.occurredDate?'date':'instant',value.occurredAt,value.occurredDate,note,actorId,recordedAt]);
}
