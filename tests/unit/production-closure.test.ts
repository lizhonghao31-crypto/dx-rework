import { randomUUID } from "node:crypto";
import { describe,expect,it,vi } from "vitest";
import type { Pool } from "pg";
import { TodoResponseSchema,ProductionExpectedReceiptsSchema } from "@dx-rework/contracts";
import { calculateProductionProgress } from "@dx-rework/domain";
import { ProductionClosureService,isProductionRiskRecipient,productionRiskKind } from "../../apps/api/src/sourcing/production-closure-service.js";
import { TodoService } from "../../apps/api/src/todos/service.js";
import { buildTodoDeepLink } from "../../apps/api/src/todos/deep-link.js";
import { todoRouteHref } from "../../apps/web/src/todo-route-link.js";
import { todoModuleIdsForUser } from "../../apps/web/src/platform-access.js";
import type { TrustedActorContext } from "../../apps/api/src/tools/repositories.js";
const user=randomUUID(),other=randomUUID();
const actor=(roles:string[],capabilities=["sourcing:view","todo:view"],id=user):TrustedActorContext=>({actorId:id,actorRoles:roles,authorizationCapability:capabilities.includes("todo:view")?"todo:view":capabilities[0]??"",authorizationCapabilities:capabilities,requestId:randomUUID()});
const todo=(n:number,unread=true)=>TodoResponseSchema.parse({todoId:randomUUID(),todoType:"business_action",category:"production_high_risk",sourceEventId:randomUUID(),sourceAction:"sourcing.production.dispatch",entityType:"production_order",entityId:randomUUID(),recipientUserId:user,requiredRole:null,requiredCapability:"sourcing:view",route:{routeName:"production_detail",entityId:randomUUID(),todoId:randomUUID()},policyKey:null,dueAt:null,reminderCount:0,status:"pending",blockedReason:null,orderContext:{reworkNo:null,orderNo:null,styleNo:`STYLE-${n}`,supplierName:"试点厂",status:"high_risk",updatedAt:new Date().toISOString()},version:1,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),unread,productionProgress:10,daysWithoutUpdate:0});
describe("production closure recipient and observation boundaries",()=>{
 it("opens a transferred factory risk in its own detail while preserving original factory links",()=>{
  const original=todo(1).route,factoryDecisionId=randomUUID(),transferred={...original,factoryDecisionId};
  expect(buildTodoDeepLink('/pilot/',original)).toBe(`/pilot/ui/production-dashboard/${original.entityId}?todo=${original.todoId}`);
  expect(buildTodoDeepLink('/pilot/',transferred)).toBe(`/pilot/ui/production-dashboard/${original.entityId}?todo=${original.todoId}&factoryDecisionId=${factoryDecisionId}`);
  expect(todoRouteHref(transferred)).toContain(`/ui/production-dashboard/${original.entityId}?todo=${original.todoId}&factoryDecisionId=${factoryDecisionId}`);
  expect(()=>TodoResponseSchema.parse({...todo(1),route:{...transferred,factoryDecisionId:'invalid'}})).toThrow();
 });
 it.each(["owner_group","production_management"])("routes %s without requiring order ownership",role=>expect(isProductionRiskRecipient(actor([role]),other)).toBe(true));
 it("routes only the corresponding merchandiser; Root uses identity and roles form a union",()=>{
  expect(isProductionRiskRecipient(actor(["order_merchandiser"]),user)).toBe(true);
  expect(isProductionRiskRecipient(actor(["order_merchandiser"]),other)).toBe(false);
  expect(isProductionRiskRecipient(actor(["owner_group","production_management","order_merchandiser"]),other)).toBe(true);
  expect(isProductionRiskRecipient(actor(["system_admin"],[]),other,true)).toBe(true);
  expect(isProductionRiskRecipient(actor(["system_admin"]),other)).toBe(false);
 });
 it.each(["factory_payables","finance_director","warehouse_receiver","production_reporter"])("does not assign risk supervision to %s",role=>expect(isProductionRiskRecipient(actor([role]),user)).toBe(false));
 it("requires view capabilities even on a permitted business role",()=>{
  expect(isProductionRiskRecipient(actor(["owner_group"],["todo:view"]),user)).toBe(false);
  expect(isProductionRiskRecipient(actor(["order_merchandiser"],["sourcing:view"]),user)).toBe(false);
 });
 it("uses the dashboard thresholds including no first report, stale precedence and completed suppression",()=>{
  const facts={status:"in_production" as const,quantity:100,completedQuantity:90,firstReportedOn:"2026-09-07",deliveryDate:"2026-09-07",lastUpdatedAt:"2026-09-07T03:00:00Z",completedOn:null};
  const risk=(change:Partial<typeof facts>,asOf="2026-09-07T04:00:00Z")=>productionRiskKind(calculateProductionProgress({...facts,...change},asOf).progressState);
  expect(risk({})).toBe("behind");expect(risk({completedQuantity:79})).toBe("high_risk");expect(risk({completedQuantity:100})).toBe(null);
  expect(productionRiskKind(calculateProductionProgress({...facts,firstReportedOn:null},"2026-09-10T04:00:00Z").progressState)).toBe(null);
  expect(risk({},"2026-09-10T04:00:00Z")).toBe("stale");
  expect(productionRiskKind(calculateProductionProgress({...facts,status:"production_completed",completedOn:"2026-09-07"},"2026-09-10T04:00:00Z").progressState)).toBe(null);
 });
 it("rejects finance expected-receipt and ordinary pilot access before database reads",async()=>{
  const query=vi.fn(),service=new ProductionClosureService({query} as unknown as Pool);
  await expect(service.expected(actor(["factory_payables"]))).rejects.toMatchObject({statusCode:403});
  await expect(service.pilots(actor(["owner_group"]))).rejects.toMatchObject({statusCode:403});
  await expect(service.setPilot(actor(["production_management"]),{supplierId:randomUUID(),enabled:true})).rejects.toMatchObject({statusCode:403});
  expect(query).not.toHaveBeenCalled();
 });
 it("adds production navigation only for intended recipients",()=>{
  expect(todoModuleIdsForUser({businessRoles:["owner_group"],capabilities:["sourcing:view","todo:view"]})).toContain("production");
  expect(todoModuleIdsForUser({businessRoles:["factory_payables"],capabilities:["sourcing:view","todo:view"]})).not.toContain("production");
  expect(todoModuleIdsForUser({businessRoles:["production_reporter"],capabilities:["production-reporting"]})).not.toContain("production");
  expect(todoModuleIdsForUser({isRoot:true,capabilities:[]})).toContain("production");
 });
 it("keeps search/pagination over active risks while the header counts only production unread",async()=>{
  const todos=Array.from({length:17},(_,i)=>todo(i,i<2)),query=vi.fn(async(sql:string)=>({rows:sql.includes("pending_count")?[{pending_count:"3"}]:[]})),adapter={todos:vi.fn(async()=>todos)};
  const service=new TodoService({query} as unknown as Pool,undefined,undefined,adapter);
  const page=await service.listForActor(actor(["owner_group"]),{module:"production",page:2});
  expect(page).toMatchObject({page:2,pageSize:15,totalCount:17,totalPages:2,moduleCounts:{production:17}});expect(page.todos).toHaveLength(2);
  const selected=await service.listForActor(actor(["owner_group"]),{module:"production",query:"STYLE-16",page:9});
  expect(selected).toMatchObject({page:1,totalCount:1});expect(selected.todos[0]!.orderContext?.styleNo).toBe("STYLE-16");
  expect(await service.countIndicatorForActor(actor(["owner_group"]))).toEqual({pendingCount:5});
 });
 it("builds a base-path-aware risk deep link and rejects price-bearing receipt DTOs",()=>{
  const item=todo(1);expect(buildTodoDeepLink("/dx/",item.route)).toBe(`/dx/ui/production-dashboard/${item.route.entityId}?todo=${item.route.todoId}`);
  const shipment={productionOrderId:randomUUID(),firstStyleNo:"A",contractNumber:"SSP-0001",supplierName:"B",shippedOn:"2026-09-05",expectedQuantity:12,receipts:[]};
  expect(ProductionExpectedReceiptsSchema.safeParse({items:[shipment],page:1,totalCount:1}).success).toBe(true);
  expect(ProductionExpectedReceiptsSchema.safeParse({items:[{...shipment,daxingUnitPrice:"8"}],page:1,totalCount:1}).success).toBe(false);
 });
});
