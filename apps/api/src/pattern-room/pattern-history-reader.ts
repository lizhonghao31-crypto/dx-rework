import type {PoolClient} from 'pg';
import {PatternHistoryListSchema,type PatternHistoryQuery} from '@dx-rework/contracts/pattern-orders';
import type {TrustedActorContext} from '../tools/repositories.js';
import {ApplicationError} from '../platform/errors.js';
import {patternOrderScopeSql,patternOrderScopeValues,canReadAllPatternOrders} from './order-authority.js';
import {DigitalProductionAccessPolicy} from '../production-platform/access-policy.js';
/** A read-only projection under the original native order and round scopes. */
export async function readPatternHistory(db:PoolClient,actor:TrustedActorContext,input:PatternHistoryQuery){
 const broad=canReadAllPatternOrders(actor);if(!broad&&(input.creatorId||input.workerId))throw new ApplicationError('FORBIDDEN','当前账号不能筛选其他人员',403);
 const available=(await db.query("SELECT to_regclass('digital_development_pattern_links') AS links,to_regclass('digital_development_route_facts') AS facts,to_regclass('digital_development_documents') AS documents")).rows[0];
 const hasLinks=Boolean(available.links),hasFacts=Boolean(available.facts),hasDocuments=Boolean(available.documents);
 const owner="(orders.created_by=$1::uuid AND ('sample_designer'=ANY($3::text[]) OR orders.kind='misc' AND 'order_merchandiser'=ANY($3::text[])))";
 const roundScope=`($2::boolean OR ${owner} OR r.round_id=orders.current_round_id OR EXISTS(SELECT 1 FROM pattern_room_segments own WHERE own.round_id=r.round_id AND own.worker_user_id=$1::uuid))`;
 const linked=hasLinks&&hasDocuments?"EXISTS(SELECT 1 FROM digital_development_pattern_links linked JOIN digital_development_documents d USING(source_id) WHERE linked.order_id=orders.order_id AND d.status='published')":'false';
 const legacySource=hasLinks?'(SELECT linked.source_id FROM digital_development_pattern_links linked WHERE linked.order_id=orders.order_id)':'NULL::uuid';
 const development=hasLinks&&hasDocuments?`UNION ALL SELECT orders.*,r.round_id AS record_round_id,r.round_index AS record_round_index,'development_completed'::text AS source,'execution_round'::text AS grain,'completed'::text AS record_status,r.handed_over_at AS record_at,r.handed_over_at AS record_completed_at,l.source_id
  FROM pattern_room_orders orders JOIN pattern_room_rounds r USING(order_id) JOIN digital_development_pattern_links l USING(order_id) JOIN digital_development_documents d ON d.source_id=l.source_id
  WHERE ${patternOrderScopeSql} AND ${roundScope} AND orders.kind='pattern' AND d.status='published' AND r.status='completed' AND r.handed_over_at IS NOT NULL`:'';
 const cte=`WITH records AS (
  SELECT orders.*,r.round_id AS record_round_id,r.round_index AS record_round_index,CASE WHEN orders.kind='misc' THEN 'misc' ELSE 'legacy_pattern' END AS source,'order'::text AS grain,orders.status AS record_status,orders.submitted_at AS record_at,CASE WHEN orders.status='completed' THEN r.handed_over_at END AS record_completed_at,${legacySource} AS source_id
  FROM pattern_room_orders orders JOIN pattern_room_rounds r ON r.round_id=orders.current_round_id
  WHERE ${patternOrderScopeSql} AND (orders.kind='misc' OR NOT ${linked}) ${development}
 ), scoped AS (SELECT * FROM records WHERE ($5::text IS NULL OR source=$5) AND ($6::text IS NULL OR record_status=$6)
  AND ($7::text IS NULL OR strpos(upper(style_no),upper($7))>0 OR strpos(upper(order_no),upper($7))>0 OR strpos(upper(COALESCE(task_name,'')),upper($7))>0)
  AND ($8::uuid IS NULL OR created_by=$8) AND ($9::uuid IS NULL OR EXISTS(SELECT 1 FROM pattern_room_segments s WHERE s.round_id=record_round_id AND s.person_id=$9)))`;
 const values=[...patternOrderScopeValues(actor),input.source??null,input.status??null,input.q||null,input.creatorId??null,input.workerId??null];
 // read() uses REPEATABLE READ so count and page share the same authorized snapshot.
 const total=(await db.query(`${cte} SELECT count(*)::int n FROM scoped`,values)).rows[0].n;
 const rows=(await db.query(`${cte} SELECT x.*,to_char(x.required_date,'YYYY-MM-DD') AS required_date,u.display_name AS creator_name,
  (SELECT s.worker_name FROM pattern_room_segments s WHERE s.round_id=x.record_round_id AND ($2::boolean OR x.created_by=$1::uuid AND ('sample_designer'=ANY($3::text[]) OR x.kind='misc' AND 'order_merchandiser'=ANY($3::text[])) OR s.worker_user_id=$1::uuid) ORDER BY s.segment_index DESC LIMIT 1) AS worker_name,
  ${hasFacts?"ARRAY(SELECT DISTINCT f.route_version FROM digital_development_route_facts f WHERE f.source_id=x.source_id AND f.kind='最终设计确认' AND f.payload->>'nativeRoundId'=x.record_round_id::text ORDER BY f.route_version)":"ARRAY[]::int[]"} AS development_rounds
  FROM scoped x JOIN app_users u ON u.id=x.created_by ORDER BY x.record_at DESC,x.order_id DESC,x.record_round_id DESC LIMIT $10 OFFSET $11`,[...values,input.limit,(input.page-1)*input.limit])).rows;
 const policy=new DigitalProductionAccessPolicy(db),items=[];
 for(const row of rows){const visibleSource=row.source_id&&await policy.allowed(actor,'source',row.source_id,'technical')?row.source_id:null;items.push({recordKey:row.grain==='order'?`order:${row.order_id}`:`round:${row.order_id}:${row.record_round_id}`,source:row.source,grain:row.grain,orderId:row.order_id,orderNo:row.order_no,kind:row.kind,styleNo:row.style_no,taskName:row.task_name,creatorName:row.creator_name,workerName:row.worker_name??null,status:row.record_status,currentStatus:row.status,nativeRoundId:row.record_round_id,nativeRoundIndex:row.record_round_index,sourceId:visibleSource,developmentRounds:visibleSource&&row.source==='development_completed'?row.development_rounds??[]:[],associationWarning:visibleSource&&row.source==='development_completed'&&!row.development_rounds?.length?'缺少对应开发轮次的最终确认记录，关联待核':visibleSource&&row.source==='legacy_pattern'?'开发关联尚无已发布资料，按原生记录保留办理；来源需核对':null,requiredDate:row.grain==='execution_round'?null:row.required_date,recordedAt:new Date(row.record_at).toISOString(),completedAt:row.record_completed_at?new Date(row.record_completed_at).toISOString():null});}
 return PatternHistoryListSchema.parse({items,totalCount:total,page:input.page,pageSize:input.limit,totalPages:Math.max(1,Math.ceil(total/input.limit)),canFilterPeople:broad});
}
