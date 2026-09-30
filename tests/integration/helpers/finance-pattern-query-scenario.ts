import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import type { Pool } from "pg";
import { expect } from "vitest";
import { PATTERN_ORDER_ROLES, PatternOrderQuerySchema } from "@dx-rework/contracts/pattern-orders";
import type { TrustedActorContext } from "../../../apps/api/src/tools/repositories.js";
import type { PatternRoomOrderService } from "../../../apps/api/src/pattern-room/order-service.js";
import { registerPatternRoomOrderRoutes } from "../../../apps/api/src/pattern-room/order-routes.js";
import type { AttachmentService } from "../../../apps/api/src/tools/attachments.js";
import { AccessMasterDataService } from "../../../apps/api/src/access/service.js";

export async function exerciseMixedFinancePatternScope(input: {database:Pool;service:PatternRoomOrderService;orderId:string;rootId:string;readers:TrustedActorContext[]}) {
  const {database,service,orderId}=input;
  const access=new AccessMasterDataService(database,"corp");
  const root:TrustedActorContext={actorId:input.rootId,actorRoles:["root_superuser"],authorizationCapability:"access:admin",requestId:randomUUID()};
  const current = await service.get(root, orderId);
  const firstRound = current.rounds[0]!;
  const assignment = await service.get(root, orderId, { round: firstRound.roundId, node: "pending_assignment" });
  expect(assignment.historicalView?.node).toBe("pending_assignment");
  expect(assignment.rounds[0]!.segments).toHaveLength(1);
  expect(Number(assignment.rounds[0]!.segments[0]!.amount)).toBe(80);
  expect(assignment.rounds[0]!.segments[0]!.endedAt).toBeNull();
  expect(assignment.rounds[0]!.completedAt).toBeNull();
  expect(Object.values(assignment.actions).every(value => !value)).toBe(true);
  const execution = await service.get(root, orderId, { round: firstRound.roundId, node: "in_progress" });
  expect(execution.rounds[0]!.segments.map(segment => Number(segment.amount))).toEqual([25.125, 10.875, 44]);
  expect(execution.rounds[0]!.segments.every(segment => !segment.wageEligible)).toBe(true);
  for(const reader of input.readers) {
    const original=await service.get(reader,orderId).catch(error=>{expect(error).toMatchObject({statusCode:404});return null;});
    if (!original) await expect(service.get(reader, orderId, { round: firstRound.roundId, node: "in_progress" })).rejects.toMatchObject({ statusCode: 404 });
    const assignment=await access.assignRole(root,{userId:reader.actorId,roleCode:"finance_read",reason:"验证混合财务不扩制作资料范围"});
    try {
      const mixed={...reader,actorRoles:[...reader.actorRoles,"finance_read"]};
      const detail=await service.get(mixed,orderId);
      expect(detail.note).toBe(original?.note??null);
      for(const round of detail.rounds) expect(round.requestReason).toBe(original?.rounds.find(item=>item.roundId===round.roundId)?.requestReason??null);
      expect(detail.attachments).toEqual(original?.attachments??[]);
      expect(detail.canReadMaterials).toBe(original?.canReadMaterials??false);
      const historical = await service.get(mixed, orderId, { round: firstRound.roundId, node: "in_progress" });
      expect(Object.values(historical.actions).every(value => !value)).toBe(true);
      expect(historical.rounds[0]!.handedOverAt).toBeNull();
      if (!original?.canReadMaterials) { expect(historical.note).toBeNull(); expect(historical.attachments).toEqual([]); }
      if(original) expect(detail.actions).toEqual(original.actions);
      else expect(Object.values(detail.actions).every(value=>!value)).toBe(true);
    } finally {await access.revokeRole(root,assignment.assignmentId,"恢复混合角色测试身份");}
  }
}

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
