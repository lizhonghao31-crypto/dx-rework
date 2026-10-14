import {minimumInitialCustomerDate} from "@dx-rework/contracts/digital-production";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { expect } from "vitest";
import { DigitalOrderCreateSchema } from "@dx-rework/contracts/digital-production";
import { DigitalProductionIdentityService } from "../../../apps/api/src/production-platform/identity-service.js";
import { DigitalProductionNotificationService } from "../../../apps/api/src/production-platform/notification-service.js";
import { DigitalProductionAccessPolicy } from "../../../apps/api/src/production-platform/access-policy.js";
import { linkNewDigitalChild } from "../../../apps/api/src/production-platform/child-link-repository.js";
import { ExternalResponsibilityService } from "../../../apps/api/src/rework/external-responsibility-service.js";
import { ReworkBusinessDetailService } from "../../../apps/api/src/rework/rework-business-detail-service.js";
import { TodoService } from "../../../apps/api/src/todos/service.js";
import type { TrustedActorContext } from "../../../apps/api/src/tools/repositories.js";

// Reuses actual N01-N11 cases and persisted roles; only notification fixtures are added.
export async function exerciseExternalCaseNotificationScope(input:{database:Pool;creator:TrustedActorContext;primaryMerchandiserId:string;reworkOrderId:string;processingCaseId:string;fabricCaseId:string;factoryActor:TrustedActorContext;fabricActor:TrustedActorContext}){
  const {database,creator,reworkOrderId,factoryActor,fabricActor,processingCaseId,fabricCaseId}=input;
  const external=new ExternalResponsibilityService(database),detail=new ReworkBusinessDetailService(database);
  const mother=await new DigitalProductionIdentityService(database,true).createOrder(creator,DigitalOrderCreateSchema.parse({customerCode:"PD",primaryMerchandiserId:input.primaryMerchandiserId,productGroup:"男装",designStyleNo:`TEST-PRIVATE-MOTHER-${randomUUID()}`,orderDate:"2026-09-29",lines:[{color:"PRIVATE",customerWarehouseArrivalDate:minimumInitialCustomerDate(),sizes:[{size:"M",quantity:1}]}]}),randomUUID());
  const notices=new DigitalProductionNotificationService(database),todos=new TodoService(database),policy=new DigitalProductionAccessPolicy(database);
  for(const [reader,ownCase,siblingCase] of [[factoryActor,processingCaseId,fabricCaseId],[fabricActor,fabricCaseId,processingCaseId]] as const){
    expect((await detail.get(reader,reworkOrderId)).styleNo).toBe("UAT-FULL-CHAIN");
    expect((await external.getCase(reader,ownCase)).reworkOrderId).toBe(reworkOrderId);
    await expect(external.getCase(reader,siblingCase)).rejects.toMatchObject({statusCode:403});
    expect(await policy.allowed(reader,"order",mother.productionOrderId,"technical")).toBe(false);
    expect(await policy.allowed(reader,"order",mother.productionOrderId,"budget")).toBe(false);
  }
  const client=await database.connect();
  const targets:Array<{todoId:string;actor:TrustedActorContext;caseId:string;allowed:boolean}>=[];
  try{
    await client.query("BEGIN");
    await linkNewDigitalChild(client,{module:"rework",childId:reworkOrderId,productionOrderId:mother.productionOrderId,lines:[]});
    for(const [reader,caseId,allowed] of [[factoryActor,processingCaseId,true],[factoryActor,fabricCaseId,false],[fabricActor,fabricCaseId,true],[fabricActor,processingCaseId,false]] as const){
      const source=randomUUID();
      await client.query("INSERT INTO operation_events(event_id,request_id,actor_id,actor_roles,authorization_capability,action,entity_type,entity_id,reason) VALUES($1,$1::uuid::text,$2,$3,'external_responsibility:sign','rework.external_responsibility.allocate','rework_order',$4,'TEST exact notification case scope')",[source,creator.actorId,creator.actorRoles,reworkOrderId]);
      const todo=await todos.createInTransaction(client,creator,{todoType:"business_action",category:"external_payables_confirmation",sourceEventId:source,sourceAction:"rework.external_responsibility.allocate",entityType:"rework_order",entityId:reworkOrderId,recipientUserId:reader.actorId,requiredRole:reader.actorRoles[0]!,requiredCapability:"external_responsibility:view",route:{routeName:"external_responsibility_detail",entityId:caseId,reworkOrderId},policyKey:"general",dedupeKey:randomUUID()});
      expect(todo.status).toBe("pending");targets.push({todoId:todo.todoId,actor:reader,caseId,allowed});
    }
    await client.query("COMMIT");
  }catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
  await notices.runOnce();
  for(const target of targets){
    const event=(await database.query("SELECT event_id FROM digital_production_notification_events WHERE todo_id=$1 AND event_kind='ready'",[target.todoId])).rows[0];
    expect(event).toBeDefined();
    // Seed only the cursor for these owned fixtures to exercise the actual current/ack readers.
    await database.query("UPDATE digital_production_notification_receipts SET shown_at=CURRENT_TIMESTAMP WHERE event_id=$1 AND recipient_id=$2",[event.event_id,target.actor.actorId]);
    const notice=(await notices.current(target.actor,event.event_id)).notification;
    if(target.allowed){
      expect(notice?.route).toMatchObject({routeName:"external_responsibility_detail",entityId:target.caseId,reworkOrderId});
      expect(notice?.context).toEqual({styleNo:"UAT-FULL-CHAIN",orderId:null,colors:[],poNumbers:[]});
      expect(JSON.stringify(notice)).not.toMatch(/PRIVATE|proposedDeductionAmount|actualDeductedAmount|supplierName|budget/);
      await notices.acknowledge(target.actor,event.event_id);
    }else{
      expect(notice).toBeNull();
      // Receipt acknowledgement is idempotent and never a business transition.
      await notices.acknowledge(target.actor,event.event_id);
    }
    expect((await database.query("SELECT status FROM rework_todos WHERE todo_id=$1",[target.todoId])).rows[0].status).toBe("pending");
  }
}
