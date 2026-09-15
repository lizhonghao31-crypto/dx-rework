import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import type { Pool } from "pg";
import { expect } from "vitest";
import { PATTERN_ORDER_ROLES, PatternOrderQuerySchema } from "@dx-rework/contracts/pattern-orders";
import type { TrustedActorContext } from "../../../apps/api/src/tools/repositories.js";
import type { PatternRoomOrderService } from "../../../apps/api/src/pattern-room/order-service.js";
import { registerPatternRoomOrderRoutes } from "../../../apps/api/src/pattern-room/order-routes.js";
import type { AttachmentService } from "../../../apps/api/src/tools/attachments.js";

export async function exerciseFinancePatternQueries(input: {database:Pool;service:PatternRoomOrderService;orderId:string;attachmentId:string;readers:Array<[string,string]>}) {
  const {database,service,orderId}=input;
  let current:TrustedActorContext;
  const app=Fastify();
  registerPatternRoomOrderRoutes(app,{service,attachments:{} as AttachmentService,
    authenticate:async()=>({id:current.actorId,businessRoles:current.actorRoles,capabilities:current.authorizationCapabilities!})});
  try {
    for(const [actorId,role] of input.readers) {
      const capabilities=(await database.query<{capability:string}>("SELECT capability FROM role_capabilities WHERE role_code=$1",[role])).rows.map(row=>row.capability);
      current={actorId,actorRoles:[role],authorizationCapability:"pattern_room:orders:view",authorizationCapabilities:capabilities,requestId:randomUUID()};
      const response=await app.inject({url:`/pattern-room/orders/${orderId}`});
      expect(response.statusCode).toBe(200);
      const detail=await service.get(current,orderId);
      expect(detail.attachments).toEqual([]);
      expect(detail.rounds[0]?.unitPrice).toBeDefined();
      expect(Object.values(detail.actions).every(value=>value===false)).toBe(true);
      expect(await service.canDownload(current,{entityType:"pattern_room_attachment",entityId:input.attachmentId})).toBe(false);
      const list=await service.list(current,PatternOrderQuerySchema.parse({q:"PATTERN-本次款号"}));
      expect(list.items.map(item=>item.orderId)).toContain(orderId);
      expect(list.canCreate).toBe(false);expect(list.canCreateMisc).toBe(false);
      expect((await app.inject({method:"POST",url:`/pattern-room/orders/${orderId}/assign`,payload:{version:detail.version,roundId:detail.currentRoundId,personId:randomUUID()},headers:{"idempotency-key":randomUUID()}})).statusCode).toBe(403);
      for(const capability of Object.keys(PATTERN_ORDER_ROLES).filter(value=>value!=="pattern_room:orders:view")) {
        await expect(database.query("SELECT pattern_room_authorized_order_roles($1,$2)",[actorId,capability])).rejects.toMatchObject({code:"42501"});
      }
    }
  } finally {await app.close();}
}
