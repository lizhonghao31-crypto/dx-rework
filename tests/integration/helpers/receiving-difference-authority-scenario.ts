import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import type { Pool } from "pg";
import { expect } from "vitest";
import { AccessMasterDataService } from "../../../apps/api/src/access/service.js";
import { RootAuthority } from "../../../apps/api/src/access/root-authority.js";
import { registerReceivingRoutes } from "../../../apps/api/src/receiving/receiving-routes.js";
import { ReceivingService } from "../../../apps/api/src/receiving/receiving-service.js";

export async function exerciseReceivingDifferenceAuthority(input:{database:Pool;rootId:string;warehouseId:string;merchants:[string,string];deniedIds:string[]}) {
  const {database,rootId,warehouseId,merchants}=input;
  const service=new ReceivingService(database,undefined,undefined,undefined,{allowLegacyStyleInput:true}),app=Fastify();
  let userId=warehouseId,stale=false;
  registerReceivingRoutes(app,{service,root:new RootAuthority(database,"corp",undefined),authenticate:async()=>{
    const roles=(await database.query<{role_code:string}>("SELECT role_code FROM user_role_assignments WHERE user_id=$1 AND revoked_at IS NULL",[userId])).rows.map(row=>row.role_code);
    const capabilities=(await database.query<{capability:string}>("SELECT DISTINCT capability FROM role_capabilities WHERE role_code=ANY($1::text[])",[roles])).rows.map(row=>row.capability);
    return {id:userId,businessRoles:stale?["order_merchandiser"]:roles,capabilities:stale?["receiving:resolve_difference"]:capabilities};
  }});
  const post=(url:string,payload:object,key=randomUUID())=>app.inject({method:"POST",url,payload,headers:{"idempotency-key":key}});
  const date=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
  const board=async()=> (await service.board(date,date,"TEST-DIFFERENCE-AUTHORITY")).rows[0]!;
  try {
    const grants=(await database.query<{role_code:string}>("SELECT role_code FROM role_capabilities WHERE capability='receiving:resolve_difference' ORDER BY role_code")).rows;
    expect(grants).toEqual([{role_code:"order_merchandiser"}]);
    const attachmentId=randomUUID();
    await database.query("INSERT INTO attachments(attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,uploaded_by,status,ready_at) VALUES($1,$2,'送货单.jpg','image/jpeg',10,$3,$4,'ready',CURRENT_TIMESTAMP)",[attachmentId,`test/${attachmentId}`,"e".repeat(64),warehouseId]);
    const created=await service.create({
      actorId:warehouseId,actorRoles:["warehouse_receiver"],authorizationCapability:"receiving:create",
      authorizationCapabilities:["receiving:create"],requestId:randomUUID(),
    },{styleNo:"TEST-DIFFERENCE-AUTHORITY",documentQuantity:100,actualQuantity:90,attachmentIds:[attachmentId]},randomUUID());
    expect(created.value.styleNo).toBe("TEST-DIFFERENCE-AUTHORITY");
    let row=await board();
    const base=`/receiving/batches/${row.receivingBatchId}`;
    const packingInput={expectedVersion:row.version,expectedPackingRevisionId:null,packingQuantity:80};
    const packingKey=randomUUID();
    expect((await post(`${base}/packing-revisions`,packingInput,packingKey)).statusCode).toBe(201);
    expect((await post(`${base}/packing-revisions`,packingInput,packingKey)).headers["idempotency-replayed"]).toBe("true");
    row=await board();
    const resolutionInput=(differenceType:"receiving"|"packing")=>({expectedVersion:row.version,expectedDocumentQuantity:row.documentQuantity,
      expectedActualQuantity:row.cumulativeActualQuantity,expectedPackingRevisionId:row.packingRevisionId,differenceType,result:"跟单已核对，保留原数量"});
    for(const denied of [warehouseId,...input.deniedIds]) {
      userId=denied;
      for(const type of ["receiving","packing"] as const) expect((await post(`${base}/difference-resolutions`,resolutionInput(type))).statusCode).toBe(403);
    }
    for(const merchant of merchants) {
      userId=merchant;
      expect((await app.inject({url:`/receiving/board?date=${date}&q=TEST-DIFFERENCE-AUTHORITY`})).statusCode).toBe(200);
      for(const type of ["receiving","packing"] as const) {
        const key=randomUUID(),payload=resolutionInput(type);
        const response=await post(`${base}/difference-resolutions`,payload,key);
        expect(response.statusCode,response.body).toBe(merchant===merchants[0]?201:409);
        if(merchant===merchants[0]){
          expect(response.json().handledBy).toBe(merchant);
          expect((await post(`${base}/difference-resolutions`,payload,key)).json().resolutionId).toBe(response.json().resolutionId);
        }
      }
      expect((await post(`${base}/packing-revisions`,{...packingInput,expectedPackingRevisionId:row.packingRevisionId,packingQuantity:95})).statusCode).toBe(403);
      expect((await post("/receiving/receipts",{styleNo:"DENIED",documentQuantity:100,actualQuantity:100})).statusCode).toBe(403);
    }
    for(const id of [warehouseId,...merchants,...input.deniedIds]) {
      userId=id;
      expect((await app.inject({method:"PATCH",url:base,payload:{expectedVersion:row.version,styleNo:row.styleNo,documentQuantity:100,actualQuantity:95}})).statusCode).toBe(403);
      expect((await post(`${base}/packing-revisions`,{...packingInput,expectedPackingRevisionId:row.packingRevisionId,packingQuantity:95})).statusCode).toBe(403);
    }
    expect(await board()).toMatchObject({documentQuantity:100,cumulativeActualQuantity:90,packingQuantity:80,differenceQuantity:-10,packingDifferenceQuantity:-10});
    expect((await database.query("SELECT count(*)::int count FROM receiving_difference_resolutions WHERE receiving_batch_id=$1",[row.receivingBatchId])).rows[0].count).toBe(2);
    // Direct database writes also reject the old warehouse/packing privileges.
    await expect(database.query(`INSERT INTO receiving_difference_resolutions
      SELECT $1,receiving_batch_id,difference_type,document_quantity_snapshot,actual_quantity_snapshot,packing_revision_id,packing_quantity_snapshot,difference_quantity_snapshot,result,$2,operation_event_id,request_id,CURRENT_TIMESTAMP
      FROM receiving_difference_resolutions WHERE receiving_batch_id=$3 LIMIT 1`,[randomUUID(),warehouseId,row.receivingBatchId])).rejects.toMatchObject({code:"42501"});
    await expect(database.query(`INSERT INTO receiving_packing_revisions
      SELECT $1,receiving_batch_id,packing_quantity+1,recorded_by,operation_event_id,request_id,CURRENT_TIMESTAMP
      FROM receiving_packing_revisions WHERE receiving_batch_id=$2 LIMIT 1`,[randomUUID(),row.receivingBatchId])).rejects.toMatchObject({code:"42501"});
    userId=warehouseId;stale=true;
    expect((await post(`${base}/difference-resolutions`,resolutionInput("receiving"))).statusCode).toBe(403);
    const access=new AccessMasterDataService(database,"corp");
    const root={actorId:rootId,actorRoles:["root_superuser"],authorizationCapability:"access:admin",requestId:randomUUID()};
    const assignment=(await access.listRoleAssignments({userId:merchants[1]})).find(item=>item.roleCode==="order_merchandiser"&&!item.revokedAt)!;
    await access.revokeRole(root,assignment.assignmentId,"验证旧会话不能沿用已撤回的差异权限");
    userId=merchants[1];
    expect((await post(`${base}/difference-resolutions`,resolutionInput("packing"))).statusCode).toBe(403);
    // An explicit second role grants discrepancy handling, but does not reopen an already handled quantity snapshot.
    stale=false;userId=warehouseId;
    const mixedRole=await access.assignRole(root,{userId:warehouseId,roleCode:"order_merchandiser",reason:"验证仓管兼任跟单的独立职责"});
    try {
      for(const type of ["receiving","packing"] as const) {
        const response=await post(`${base}/difference-resolutions`,resolutionInput(type));
        expect(response.statusCode,response.body).toBe(409);
      }
      expect((await post(`${base}/packing-revisions`,{...packingInput,expectedPackingRevisionId:row.packingRevisionId,packingQuantity:95})).statusCode).toBe(403);
      expect((await app.inject({method:"PATCH",url:base,payload:{expectedVersion:row.version,styleNo:row.styleNo,documentQuantity:100,actualQuantity:95}})).statusCode).toBe(403);
    } finally {
      await access.revokeRole(root,mixedRole.assignmentId,"结束兼岗验收并检查旧会话撤权");
    }
    stale=true;
    for(const type of ["receiving","packing"] as const) expect((await post(`${base}/difference-resolutions`,resolutionInput(type))).statusCode).toBe(403);
    expect(await board()).toMatchObject({documentQuantity:100,cumulativeActualQuantity:90,packingQuantity:80,differenceQuantity:-10,packingDifferenceQuantity:-10});
    expect((await database.query("SELECT count(*)::int count FROM receiving_difference_resolutions WHERE receiving_batch_id=$1",[row.receivingBatchId])).rows[0].count).toBe(2);
    stale=false;userId=rootId;
    expect((await post(`${base}/packing-revisions`,{...packingInput,expectedPackingRevisionId:row.packingRevisionId,packingQuantity:82})).statusCode).toBe(201);
    const correction=await app.inject({method:"PATCH",url:base,payload:{expectedVersion:row.version,styleNo:row.styleNo,documentQuantity:100,actualQuantity:92}});
    expect(correction.statusCode,correction.body).toBe(200);
    const request=(await database.query(`SELECT c.request_id,e.request_id AS audited_request FROM receiving_receipt_corrections c
      JOIN operation_events e ON e.event_id=c.operation_event_id WHERE c.receipt_id=$1 ORDER BY c.created_at DESC LIMIT 1`,[created.value.receiptId])).rows[0]!;
    expect(request.request_id).toBe(request.audited_request);
    expect(request.request_id).toMatch(/^req-/);
    row=await board();
    for(const type of ["receiving","packing"] as const) expect((await post(`${base}/difference-resolutions`,resolutionInput(type))).statusCode).toBe(201);
    expect(row).toMatchObject({documentQuantity:100,cumulativeActualQuantity:92,packingQuantity:82});
    expect((await database.query("SELECT count(*)::int count FROM receiving_difference_resolutions WHERE receiving_batch_id=$1",[row.receivingBatchId])).rows[0].count).toBe(4);
  } finally {await app.close();}
}
