import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { TodoRouteDescriptor } from "@dx-rework/contracts";
import { afterEach,describe,expect,it,vi } from "vitest";
import { DigitalProductionNotificationService } from "../../apps/api/src/production-platform/notification-service.js";
import { DigitalProductionAccessPolicy } from "../../apps/api/src/production-platform/access-policy.js";
import { SourcingProductionService } from "../../apps/api/src/sourcing/sourcing-production-service.js";
import { ReworkBusinessDetailService } from "../../apps/api/src/rework/rework-business-detail-service.js";
import { ApplicationError } from "../../apps/api/src/platform/errors.js";
import type { TrustedActorContext } from "../../apps/api/src/tools/repositories.js";

describe("digital notification delegates exact child scope to existing readers",()=>{
  afterEach(()=>vi.restoreAllMocks());
  const fixture=(routeName:TodoRouteDescriptor["routeName"],bound=false)=>{
    const child=randomUUID(),mother=randomUUID(),eventId=randomUUID(),todoId=randomUUID();
    const actor:TrustedActorContext={actorId:randomUUID(),actorRoles:["order_merchandiser"],authorizationCapability:"todo:view",authorizationCapabilities:["todo:view","sourcing:view"],requestId:randomUUID()};
    const production=routeName==="production_detail";
    const route:TodoRouteDescriptor={routeName,entityId:bound?randomUUID():child,todoId,...(bound?{reworkOrderId:child}:{})};
    const row={todo_type:"business_action",required_role:"order_merchandiser",required_capability:"sourcing:view",entity_type:production?"sourcing_production_order":"rework_order",entity_id:child,route_descriptor:route};
    const query=vi.fn(async(sql:string)=>{
      if(sql.includes("FROM digital_production_notification_events e JOIN"))return {rows:[{event_id:eventId,todo_id:todoId,event_kind:"ready",created_at:new Date()}],rowCount:1};
      if(sql.includes("array_agg(DISTINCT r.role_code)"))return {rows:[{id:actor.actorId,roles:actor.actorRoles}],rowCount:1};
      if(sql.startsWith("SELECT * FROM rework_todos"))return {rows:[row],rowCount:1};
      if(sql.includes("to_regclass('digital_production_child_links')"))return {rows:[{relation:"digital_production_child_links"}],rowCount:1};
      if(sql.includes("SELECT l.production_order_id"))return {rows:[{production_order_id:mother}],rowCount:1};
      if(sql.startsWith("SELECT 1 FROM digital_production_resource_lifecycle"))return {rows:[],rowCount:0};
      if(sql.startsWith("UPDATE digital_production_notification_receipts"))return {rows:[],rowCount:1};
      throw new Error(`Unexpected query: ${sql}`);
    });
    vi.spyOn(DigitalProductionAccessPolicy.prototype,"activeRole").mockResolvedValue(true);
    vi.spyOn(DigitalProductionAccessPolicy.prototype,"allowed").mockResolvedValue(false);
    const reader=production
      ? vi.spyOn(SourcingProductionService.prototype,"get").mockResolvedValue({firstStyleNo:"TEST-EXACT-CHILD",price:"PRIVATE"} as unknown as Awaited<ReturnType<SourcingProductionService["get"]>>)
      : vi.spyOn(ReworkBusinessDetailService.prototype,"get").mockResolvedValue({styleNo:"TEST-EXACT-CHILD",status:"active",budget:"PRIVATE"} as unknown as Awaited<ReturnType<ReworkBusinessDetailService["get"]>>);
    return {child,eventId,actor,route,row,query,reader,notices:new DigitalProductionNotificationService({query} as unknown as Pool)};
  };
  it.each([
    ["production_detail",false], ["rework_detail",false], ["process_configuration",true],
    ["whole_order_review",true], ["responsibility_detail",true], ["own_factory_approval",true],
  ] as const)("projects only the identity authorized by the exact %s reader",async(routeName,bound)=>{
    const f=fixture(routeName,bound),notice=(await f.notices.current(f.actor,f.eventId)).notification!;
    expect(f.reader).toHaveBeenCalledWith(f.actor,f.child);
    expect(notice.route).toEqual(f.route);
    expect(notice.context).toEqual({styleNo:"TEST-EXACT-CHILD",orderId:null,colors:[],poNumbers:[]});
    expect(JSON.stringify(notice)).not.toMatch(/PRIVATE|budget|price/);
    await f.notices.acknowledge(f.actor,f.eventId);
    expect(f.query.mock.calls.filter(([sql])=>sql.startsWith("UPDATE")).map(([sql])=>sql)).toEqual([expect.stringContaining("notification_receipts SET acknowledged_at")]);
  });
  it.each([403,404])("requires the child reader even when recipient and role are effective (%s)",async(statusCode)=>{
    const f=fixture("production_detail");f.reader.mockRejectedValue(new ApplicationError("FORBIDDEN","outside child scope",statusCode));
    expect((await f.notices.current(f.actor,f.eventId)).notification).toBeNull();
    expect(f.reader).toHaveBeenCalledWith(f.actor,f.child);
  });
  it("rejects a bound rework identity that belongs to another business object",async()=>{
    const f=fixture("process_configuration",true);f.row.entity_id=randomUUID();
    expect((await f.notices.current(f.actor,f.eventId)).notification).toBeNull();expect(f.reader).not.toHaveBeenCalled();
  });
  it("drops a cancelled child even when its historical detail remains readable",async()=>{
    const f=fixture("rework_detail");f.reader.mockResolvedValue({styleNo:"TEST-CANCELLED",status:"cancelled"} as never);
    expect((await f.notices.current(f.actor,f.eventId)).notification).toBeNull();
  });
});
