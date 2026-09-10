import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { OrderResponsibilityRevisionSchema, type ReopenOrderResponsibility } from '@dx-rework/contracts';
import { isRootActor } from '../access/business-authority.js';
import { ApplicationError } from '../platform/errors.js';
import { IdempotencyService, OperationEventRepository, type TrustedActorContext } from '../tools/repositories.js';
import type { TodoProjectionService } from '../todos/projection-service.js';
import { AuthorizedResponsibilityDeterminationService } from './responsibility-determination-authorized-service.js';
const fail = (message: string, status = 409): never => { throw new ApplicationError(status === 403 ? 'FORBIDDEN' : 'CONFLICT', message, status); };
export class OrderResponsibilityRevisionService {
  private readonly events = new OperationEventRepository();
  private readonly idempotency = new IdempotencyService();
  private readonly determinations: AuthorizedResponsibilityDeterminationService;
  constructor(private readonly database: Pool, private readonly todos?: TodoProjectionService) { this.determinations = new AuthorizedResponsibilityDeterminationService(database, todos); }
  private async permitted(client: Pool | PoolClient, actor: TrustedActorContext) {
    if (isRootActor(actor)) return true;
    const caps = actor.authorizationCapabilities ?? [actor.authorizationCapability];
    if (!caps.includes('responsibility:determine') || !caps.includes('external_responsibility:approve_revision')) return false;
    const result = await client.query<{ok: boolean}>("SELECT external_responsibility_direct_role($1,'external_responsibility:approve_revision',ARRAY['production_management','owner_group']) AS ok", [actor.actorId]);
    return result.rows[0]?.ok === true;
  }
  async get(actor: TrustedActorContext, id: string, client: Pool | PoolClient = this.database) {
    const current = await this.determinations.get(actor, id, client);
    const history = await client.query(`SELECT d.determination_id AS id,d.determination_version AS version,d.stage,d.reason,d.created_at AS at,u.display_name AS actor,
      COALESCE((SELECT sum(a.rounded_amount) FROM rework_responsibility_allocations a WHERE a.determination_id=d.determination_id AND a.responsibility_type='own_factory'),0)::text AS "ownAmount",
      COALESCE((SELECT sum(a.rounded_amount) FROM rework_responsibility_allocations a WHERE a.determination_id=d.determination_id AND a.responsibility_type<>'own_factory'),0)::text AS "externalAmount",
      (SELECT jsonb_build_object('decision',s.decision,'actor',signer.display_name,'at',s.signed_at) FROM rework_responsibility_owner_signatures s LEFT JOIN app_users signer ON signer.id=s.signed_by WHERE s.determination_id=d.determination_id ORDER BY s.signed_at DESC LIMIT 1) AS signature
      FROM rework_responsibility_determinations d LEFT JOIN app_users u ON u.id=d.created_by WHERE d.rework_order_id=$1 ORDER BY d.determination_version DESC`, [id]);
    const revisions = await client.query(`SELECT e.event_id AS id,e.reason,u.display_name AS actor,e.created_at AS at FROM operation_events e LEFT JOIN app_users u ON u.id=e.actor_id
      WHERE e.entity_type='rework_order' AND e.entity_id=$1 AND e.action='rework.responsibility.reopen' ORDER BY e.created_at DESC`, [id]);
    const paid = await client.query<{amount: string}>(`SELECT COALESCE(sum(e.amount),0)::text amount FROM rework_external_deduction_entries e JOIN rework_external_responsibility_cases c USING(case_id) WHERE c.rework_order_id=$1`, [id]);
    return OrderResponsibilityRevisionSchema.parse({orderVersion:current.orderVersion,status:current.reworkStatus,currentVersion:current.determination?.version??null,
      canReopen:['completed','pending_responsibility_action'].includes(current.reworkStatus)&&current.determination?.stage==='finalized'&&await this.permitted(client,actor),
      history:history.rows.map(row=>({...row,at:new Date(row.at).toISOString()})),revisions:revisions.rows.map(row=>({...row,at:new Date(row.at).toISOString()})),paidAmount:paid.rows[0]!.amount});
  }
  async reopen(actor: TrustedActorContext, id: string, input: ReopenOrderResponsibility, key: string) {
    if (!await this.permitted(this.database, actor)) fail('只有现有正式重判审核角色或Root可以重新判责',403);
    const client = await this.database.connect();
    try {
      await client.query('BEGIN');
      const result = await this.idempotency.execute(client,{scope:'rework.responsibility.reopen',actorKey:actor.actorId,key,
        requestHash:createHash('sha256').update(JSON.stringify({id,input})).digest('hex'),expiresAt:new Date(Date.now()+30*86400000)},async()=>{
        const order = (await client.query("SELECT * FROM rework_orders WHERE rework_order_id=$1 AND status<>'deleted' FOR UPDATE",[id])).rows[0] ?? fail('返工单不存在',404);
        if (order.version!==input.expectedOrderVersion||!['completed','pending_responsibility_action'].includes(order.status)) fail('订单状态已变化，请刷新后重新核对');
        const leaf = (await client.query(`SELECT * FROM rework_responsibility_determinations d WHERE rework_order_id=$1 AND NOT EXISTS(SELECT 1 FROM rework_responsibility_determinations next WHERE next.replaces_determination_id=d.determination_id) FOR UPDATE`,[id])).rows[0];
        if (!leaf||leaf.stage!=='finalized'||leaf.determination_version!==input.expectedDeterminationVersion) fail('当前责任版本已变化，请刷新后重试');
        const draftId=randomUUID();
        const audit={reworkOrderId:id,reworkNo:order.rework_no,status:order.status,styleNo:order.style_no,orderNo:order.order_no,
          merchandiserUserId:order.merchandiser_user_id,processingFactory:order.processing_factory_type===null?null:order.processing_factory_type==='own_factory'?{type:'own_factory'}:{type:'supplier',supplierId:order.processing_factory_supplier_id,supplierVersion:order.processing_factory_supplier_version},
          problemPart:order.problem_part,problemDescription:order.problem_description,reworkQuantity:order.rework_quantity,version:order.version};
        const eventId=await this.events.append(client,{...actor,authorizationCapability:'responsibility:determine'},{action:'rework.responsibility.reopen',entityType:'rework_order',entityId:id,before:audit,
          after:{...audit,status:'pending_responsibility_determination',version:order.version+1,sourceDeterminationId:leaf.determination_id,sourceDeterminationVersion:leaf.determination_version,newDeterminationId:draftId},reason:input.reason});
        await client.query(`SELECT set_config('dx_rework.rework_event_id',$1,true),set_config('dx_rework.rework_request_id',$2,true),set_config('dx_rework.responsibility_event_id',$1,true),set_config('dx_rework.responsibility_request_id',$2,true),set_config('dx_rework.external_responsibility_event_id',$1,true),set_config('dx_rework.external_responsibility_request_id',$2,true)`,[eventId,actor.requestId]);
        await client.query("UPDATE rework_orders SET status='pending_responsibility_determination',version=version+1,updated_by=$2,updated_at=CURRENT_TIMESTAMP WHERE rework_order_id=$1",[id,actor.actorId]);
        await client.query(`INSERT INTO rework_responsibility_determinations(determination_id,rework_order_id,determination_version,replaces_determination_id,source_order_review_id,stage,handler_user_id,created_by,reason,input_snapshot,calculation_total,operation_event_id,request_id,settlement_schema_version)
          SELECT $1,rework_order_id,determination_version+1,determination_id,source_order_review_id,'draft',handler_user_id,$2,$3,input_snapshot,calculation_total,$4,$5,settlement_schema_version FROM rework_responsibility_determinations WHERE determination_id=$6`,[draftId,actor.actorId,input.reason,eventId,actor.requestId,leaf.determination_id]);
        await client.query(`INSERT INTO rework_responsibility_processes SELECT $1,configuration_item_id,process_name_snapshot,pricing_unit_snapshot,multiplier,high_multiplier_reason,base_amount,responsibility_amount,$2,$3 FROM rework_responsibility_processes WHERE determination_id=$4`,[draftId,eventId,actor.requestId,leaf.determination_id]);
        await client.query(`INSERT INTO rework_responsibility_allocations(determination_id,configuration_item_id,responsibility_type,share_bps,rounded_amount,operation_event_id,request_id,multiplier,supplier_id,supplier_version,supplier_code_snapshot,supplier_name_snapshot,supplier_type_snapshot)
          SELECT $1,configuration_item_id,responsibility_type,share_bps,rounded_amount,$2,$3,multiplier,supplier_id,supplier_version,supplier_code_snapshot,supplier_name_snapshot,supplier_type_snapshot FROM rework_responsibility_allocations WHERE determination_id=$4`,[draftId,eventId,actor.requestId,leaf.determination_id]);
        await client.query(`INSERT INTO rework_responsibility_amount_lines SELECT $1,configuration_item_id,work_report_id,person_id,responsibility_type,base_member_share_amount,multiplier,share_bps,unrounded_amount,rounded_amount,rounding_rule,worker_display_name_snapshot,task_mode_snapshot,member_snapshot,report_snapshot,$2,$3 FROM rework_responsibility_amount_lines WHERE determination_id=$4`,[draftId,eventId,actor.requestId,leaf.determination_id]);
        const cases=await client.query<{case_id:string}>("SELECT c.case_id FROM rework_external_responsibility_cases c JOIN rework_external_responsibility_batches b USING(batch_id) WHERE b.rework_order_id=$1 AND b.status='active' AND c.status NOT IN ('closed','superseded') FOR UPDATE OF c",[id]);
        await client.query("UPDATE rework_external_responsibility_cases c SET status='superseded',case_version=case_version+1 FROM rework_external_responsibility_batches b WHERE c.batch_id=b.batch_id AND b.rework_order_id=$1 AND b.status='active' AND c.status NOT IN ('closed','superseded')",[id]);
        await client.query("UPDATE rework_external_responsibility_batches SET status='superseded',batch_version=batch_version+1 WHERE rework_order_id=$1 AND status='active'",[id]);
        for(const row of cases.rows) for(const prefix of ['external-signoff','external-payables','external-return','deduction-follow-up','deduction-overdue','external-deduction','external-special','external-special-return']) await this.todos?.cancelOpenByDedupePrefix(client,actor,`${prefix}:${row.case_id}:`,'订单重新判责，原扣款事实保留');
        await this.todos?.actionableForResponsibilityHandler(client,actor,{category:'responsibility_determination',sourceEventId:eventId,sourceAction:'rework.responsibility.reopen',entityType:'rework_order',entityId:id,recipientUserId:leaf.handler_user_id,route:{routeName:'responsibility_detail',entityId:id},dedupeKey:`responsibility:${id}:revision:${draftId}`});
        return {statusCode:201,response:await this.get(actor,id,client)};
      });
      await client.query('COMMIT');return {value:result.response,reused:result.reused};
    } catch(error) { await client.query('ROLLBACK');throw error; } finally { client.release(); }
  }
}
