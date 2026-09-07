import { ProductionDashboardService } from "../../apps/api/src/sourcing/production-dashboard-service.js";
import { ProductionExclusionService } from "../../apps/api/src/sourcing/production-exclusion-service.js";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { afterAll,beforeAll,describe,expect,it } from "vitest";
import { CreateSupplierSchema } from "@dx-rework/contracts";
import { shanghaiDay } from "@dx-rework/domain";
import { AccessMasterDataService } from "../../apps/api/src/access/service.js";
import { SourcingService } from "../../apps/api/src/sourcing/sourcing-service.js";
import { SourcingContractService } from "../../apps/api/src/sourcing/sourcing-contract-service.js";
import { SourcingProductionService } from "../../apps/api/src/sourcing/sourcing-production-service.js";
import { ProductionReportingService } from "../../apps/api/src/sourcing/production-reporting-service.js";
import { ProductionClosureService } from "../../apps/api/src/sourcing/production-closure-service.js";
import { ReceivingService } from "../../apps/api/src/receiving/receiving-service.js";
import { AttachmentService } from "../../apps/api/src/tools/attachments.js";
import { FakeObjectStorage } from "../../apps/api/src/tools/storage.js";
import type { TrustedActorContext } from "../../apps/api/src/tools/repositories.js";
const url=process.env.TEST_DATABASE_URL??process.env.DATABASE_URL;
(url?describe:describe.skip)("SSP09 full-schema dispatch to actual receipt",()=>{
 const schema=`sourcing_${randomUUID().replaceAll("-","")}`,admin=new pg.Pool({connectionString:url!}),database=new pg.Pool({connectionString:url!,options:`-c search_path=${schema}`});
 const user=randomUUID(),owner=randomUUID(),warehouse=randomUUID();
 const actor=(id:string,roles:string[],capabilities:string[]):TrustedActorContext=>({actorId:id,actorRoles:roles,authorizationCapability:capabilities[0]!,authorizationCapabilities:capabilities,requestId:randomUUID()});
 const root=(capability="sourcing:view")=>actor(user,["root_superuser"],[capability,"sourcing:view","todo:view","receiving:create"]);
 const merch=()=>actor(user,["order_merchandiser"],["sourcing:inquiry:create","sourcing:view","todo:view"]);
 const boss=()=>actor(owner,["owner_group","production_management"],["sourcing:owner:approve","sourcing:view","todo:view"]);
 const receiver=()=>actor(warehouse,["warehouse_receiver"],["receiving:create"]);
 const contracts=new SourcingContractService(database,new AttachmentService(database,new FakeObjectStorage(),{prefix:"tests",ttlSeconds:60,maxUploadBytes:5000000}));
 const projection={actionableForAllAssignedRole:async()=>[],cancelOpenByDedupePrefix:async()=>0,completeOpenByDedupePrefix:async()=>0,information:async()=>undefined};
 const sourcing=new SourcingService(database,undefined,undefined,projection,contracts),production=new SourcingProductionService(database),reporting=new ProductionReportingService(database,undefined,undefined,new ProductionClosureService(database));
 const closure=new ProductionClosureService(database),receiving=new ReceivingService(database,undefined,undefined,closure);
 const factories:string[]=[];let craftId="";
 const today=()=>shanghaiDay(new Date());
 const readyImage=async()=>{
  const attachmentId=randomUUID(),sha256=`${randomUUID().replaceAll("-","")}${randomUUID().replaceAll("-","")}`;
  await database.query(`INSERT INTO attachments(
    attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,
    uploaded_by,status,ready_at
  ) VALUES($1,$2,$3,'image/jpeg',100,$4,$5,'ready',CURRENT_TIMESTAMP)`,
  [attachmentId,`ssp09-receiving/${attachmentId}`,`${attachmentId}.jpg`,sha256,warehouse]);
  return attachmentId;
 };
 beforeAll(async()=>{
  await admin.query(`CREATE SCHEMA ${schema}`);
  const manifest=JSON.parse(await readFile(new URL("../../apps/api/src/platform/migration-manifest.json",import.meta.url),"utf8")) as {migrations:{version:string;checksum:string}[]};
  // Full-schema migrations inspect their recorded predecessors, just as in the deploy runner.
  await database.query(`CREATE TABLE schema_migrations (
    version text PRIMARY KEY,
    checksum char(64) NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  const client=await database.connect();
  try {
    for(const item of manifest.migrations) {
      await client.query("BEGIN");
      try {
        await client.query(await readFile(new URL(`../../apps/api/migrations/${item.version}.sql`,import.meta.url),"utf8"));
        await client.query("INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)",[item.version,item.checksum]);
        await client.query("COMMIT");
      } catch(error) { await client.query("ROLLBACK"); throw error; }
    }
  } finally { client.release(); }
  // Use the established full-chain bootstrap: organization identities and real role grants
  // are seeded before locking the corporation policy; production guards stay enabled.
  for(const [id,name,roles] of [
    [user,"SSP09跟单",["order_merchandiser","ie_reviewer","production_management","system_admin"]],
    [owner,"SSP09老板",["owner_group"]],
    [warehouse,"SSP09仓库",["warehouse_receiver"]],
  ] as const) {
    await database.query("INSERT INTO app_users(id,display_name,enabled) VALUES($1,$2,true)",[id,name]);
    await database.query(`INSERT INTO identity_mappings(id,user_id,provider,corp_id,provider_user_id,union_id,active,employed,last_verified_at)
      VALUES($1,$2,'dingtalk','corp',$3,$4,true,true,CURRENT_TIMESTAMP)`,[randomUUID(),id,`ding-${id}`,`union-${id}`]);
    for(const role of roles)await database.query(`INSERT INTO user_role_assignments(assignment_id,user_id,role_code,granted_by,grant_reason)
      VALUES($1,$2,$3,$2,'SSP09 full-chain fixture')`,[randomUUID(),id,role]);
  }
  const access=new AccessMasterDataService(database,"corp");
  await access.ensureOrganizationPolicy();
  craftId=(await access.ensureCrafts(root("master_data:manage"),{craftNames:["车缝＋线＋包装，回厂装箱＋一程运费"]}))[0]!.craftId;
  for(let i=1;i<=3;i++)factories.push((await access.createSupplier(root("supplier_profile:write"),CreateSupplierSchema.parse({supplierCode:`SSP09-${i}`,supplierType:"factory",supplierName:`试点厂${i}`,active:true,changeReason:"SSP09合成验收数据",address:`试点路${i}号`,contractEntityName:`试点厂${i}有限公司`,partyBRepresentative:"试点代表",payeeName:"试点收款人",bankAccount:`62220${i}`,bankName:"测试银行"}))).supplierId);
 },60000);
 afterAll(async()=>{await database.end();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();});
 const create=async(supplierId:string,suffix:string)=>{
  const created=await sourcing.createCase(merch(),{gender:"女装",styleName:"试点上衣",estimatedCutPieceSendDate:today(),deliveryDate:today(),
   lineItems:[{styleNo:`SSP09-${suffix}-A`,color:"蓝",quantity:20,externalUnitPrice:"8.0000"},{styleNo:`SSP09-${suffix}-B`,color:"白",quantity:10,externalUnitPrice:"9.0000"}],daxingUnitPrice:"777.1234"},randomUUID());
  const id=created.value.sourcingCaseId,prices=[{position:1,unitPrice:"8.0000"},{position:2,unitPrice:"9.0000"}];
  await sourcing.quoteIePrice(actor(user,["ie_reviewer"],["sourcing:price:quote","sourcing:view"]),id,{linePrices:prices},randomUUID());
  await sourcing.recordManagementDecision(actor(user,["production_management"],["sourcing:decision:record","sourcing:view"]),id,{supplierId,linePrices:prices,craftIds:[craftId]},randomUUID());
  await sourcing.decideOwner(boss(),id,{decision:"approved"},randomUUID());
  const contract=(await contracts.getCurrent(root(),id)).item!;
  return (await production.dispatch(root(),id,{sourcingContractDocumentId:contract.sourcingContractDocumentId,confirmed:true},randomUUID())).value;
 };
 it("routes one risk per person, preserves other unread markers, closes/reopens episodes and never pushes",async()=>{
  const order=await create(factories[0]!,"RISK");
  expect(await closure.todos(merch())).toEqual([]);
  await expect(closure.setPilot(boss(),{supplierId:factories[0],enabled:true})).rejects.toMatchObject({statusCode:403});
  await closure.setPilot(root(),{supplierId:factories[0],enabled:true});
  await closure.setPilot(root(),{supplierId:factories[0],enabled:true});
  expect(await closure.todos(merch())).toEqual([]); // no first report => no alarm
  const report=await reporting.report(root(),order.productionOrderId,{position:1,businessDate:today(),quantity:5},randomUUID());
  const [a,b]=await Promise.all([closure.todos(merch()),closure.todos(boss())]);
  expect(a).toHaveLength(1);expect(b).toHaveLength(1);expect(a[0]!.todoId).toBe(b[0]!.todoId);
  expect(a[0]).toMatchObject({category:"production_high_risk",unread:true});
  const source=await database.query<{action:string}>("SELECT action FROM operation_events WHERE event_id=$1",[a[0]!.sourceEventId]);
  expect(source.rows[0]?.action).toBe(a[0]!.sourceAction);
  expect(await closure.todos(actor(warehouse,["order_merchandiser"],["sourcing:view","todo:view"]))).toEqual([]);
  expect(await closure.todos(actor(warehouse,["factory_payables"],["sourcing:view","todo:view"]))).toEqual([]);
  await expect(closure.markRead(receiver(),a[0]!.todoId)).rejects.toMatchObject({statusCode:404});
  await Promise.all([closure.markRead(merch(),a[0]!.todoId),closure.markRead(merch(),a[0]!.todoId)]);
  expect((await closure.todos(merch()))[0]).toMatchObject({unread:false,status:"pending"});
  expect((await closure.todos(boss()))[0]).toMatchObject({unread:true,status:"pending"});
  const original=report.value.history[0]!;
  await reporting.correct(root(),order.productionOrderId,original.rootReportId,{expectedReportId:original.reportId,businessDate:today(),quantity:0,reason:"撤销错误首报"},randomUUID());
  expect((await database.query("SELECT 1 FROM sourcing_production_alerts WHERE production_order_id=$1 AND resolved_at IS NULL",[order.productionOrderId])).rowCount).toBe(0);
  await reporting.report(root(),order.productionOrderId,{position:1,businessDate:today(),quantity:5},randomUUID());
  const reopened=(await closure.todos(merch()))[0]!;expect(reopened.todoId).not.toBe(a[0]!.todoId);expect(reopened.unread).toBe(true);
  const future=new ProductionClosureService(database,undefined,()=>new Date(Date.now()+3*86400000));
  expect((await future.todos(merch()))[0]).toMatchObject({category:"production_stale",daysWithoutUpdate:3});
  await reporting.execute(root(),order.productionOrderId,"complete",{businessDate:today(),confirmed:true},randomUUID());
  expect(await closure.todos(merch())).toEqual([]);
  expect((await database.query("SELECT 1 FROM message_outbox WHERE topic='todo.delivery'")).rowCount).toBe(0);
 });
 it("keeps shipped distinct from received and atomically links only the selected shipment",async()=>{
  const order=await create(factories[1]!,"RECEIPT"),off=await create(factories[2]!,"OFF");
  await closure.setPilot(root(),{supplierId:factories[1],enabled:true});
  const payload={styleNo:order.firstStyleNo,documentQuantity:25,actualQuantity:24,
   attachmentIds:[await readyImage()],productionOrderId:order.productionOrderId};
  await expect(receiving.create(receiver(),payload,randomUUID())).rejects.toMatchObject({statusCode:409});
  for(const item of [order,off]){await reporting.report(root(),item.productionOrderId,{position:1,businessDate:today(),quantity:20},randomUUID());
   await reporting.report(root(),item.productionOrderId,{position:2,businessDate:today(),quantity:5},randomUUID());
   await reporting.execute(root(),item.productionOrderId,"complete",{businessDate:today(),confirmed:true},randomUUID());
   const key=randomUUID();await reporting.execute(root(),item.productionOrderId,"ship",{businessDate:today(),confirmed:true},key);
   await reporting.execute(root(),item.productionOrderId,"ship",{businessDate:today(),confirmed:true},key);}
  expect((await closure.expected(receiver())).items.map(s=>s.productionOrderId)).toContain(order.productionOrderId);
  expect((await closure.expected(receiver())).items.map(s=>s.productionOrderId)).not.toContain(off.productionOrderId);
  expect((await closure.receiptSummary(root(),order.productionOrderId)).shipment).toMatchObject({firstStyleNo:order.firstStyleNo,expectedQuantity:25,receipts:[]});
  await expect(closure.expected(boss())).rejects.toMatchObject({statusCode:403});
  await expect(receiving.create(receiver(),{...payload,styleNo:order.lines[1]!.styleNo},randomUUID())).rejects.toMatchObject({statusCode:409});
  await expect(receiving.create(receiver(),{...payload,productionOrderId:off.productionOrderId},randomUUID())).rejects.toMatchObject({statusCode:409});
  const key=randomUUID();const [first,replay]=await Promise.all([receiving.create(receiver(),payload,key),receiving.create(receiver(),payload,key)]);
  expect(first.value.receiptId).toBe(replay.value.receiptId);
  expect((await database.query("SELECT 1 FROM sourcing_production_receipt_links WHERE production_order_id=$1",[order.productionOrderId])).rowCount).toBe(1);
  await expect(receiving.create(receiver(),{...payload,productionOrderId:off.productionOrderId},key)).rejects.toMatchObject({code:"IDEMPOTENCY_CONFLICT"});
  const second=await receiving.createRepeated(receiver(),{receivingBatchId:first.value.receivingBatchId,source:"other_factory",documentQuantity:1,actualQuantity:1,productionOrderId:order.productionOrderId},randomUUID());
  expect((await closure.receiptSummary(root(),order.productionOrderId)).shipment?.receipts.map(r=>r.actualQuantity)).toEqual([24,1]);
  expect(second.value.styleNo).toBe(order.firstStyleNo);
  const summary=JSON.stringify(await closure.receiptSummary(root(),order.productionOrderId));expect(summary).not.toMatch(/777\.1234|daxing|unitPrice|bankAccount/);
  await closure.setPilot(root(),{supplierId:factories[1],enabled:false});
  expect((await closure.expected(receiver())).items.some(s=>s.productionOrderId===order.productionOrderId)).toBe(false);
  expect((await closure.receiptSummary(root(),order.productionOrderId)).shipment?.receipts).toHaveLength(2);
  expect((await database.query("SELECT 1 FROM sourcing_finance_reconciliations")).rowCount).toBe(0);
 },60000);
 it("excludes only the confirmed production object with Root audit, version protection and replay",async()=>{
  const order=await create(factories[0]!,"EXCLUDE"),id=order.productionOrderId;
  const exclusions=new ProductionExclusionService(database),dashboard=new ProductionDashboardService(database,reporting);
  await closure.setPilot(root(),{supplierId:factories[0],enabled:true});
  await expect(exclusions.preview(boss(),id)).rejects.toMatchObject({statusCode:403});
  const first=await exclusions.preview(root(),id);
  const input={expectedVersion:first.version,confirmedProductionOrderId:id,confirmed:true as const,reason:"本轮合成测试记录隔离"};
  await expect(exclusions.exclude(boss(),id,input,randomUUID())).rejects.toMatchObject({statusCode:403});
  await expect(exclusions.exclude(root(),id,{...input,confirmedProductionOrderId:randomUUID()},randomUUID())).rejects.toMatchObject({statusCode:400});
  await reporting.report(root(),id,{position:1,businessDate:today(),quantity:1},randomUUID());
  await expect(exclusions.exclude(root(),id,input,randomUUID())).rejects.toMatchObject({statusCode:409});
  const fresh=await exclusions.preview(root(),id);
  expect(fresh.version).not.toBe(first.version);expect(fresh.reportCount).toBe(1);
  const key=randomUUID(),payload={...input,expectedVersion:fresh.version};
  const results=await Promise.all([exclusions.exclude(root(),id,payload,key),exclusions.exclude(root(),id,payload,key)]);
  expect(results.filter(r=>r.reused)).toHaveLength(1);
  expect(results[0]!.value.exclusion?.reason).toBe(payload.reason);
  expect((await exclusions.preview(root(),id)).exclusion?.reason).toBe(payload.reason);
  expect((await database.query("SELECT 1 FROM operation_events WHERE action='sourcing.production.exclude' AND entity_id=$1",[id])).rowCount).toBe(1);
  await expect(exclusions.exclude(root(),id,{...payload,reason:"试图改写原因"},key)).rejects.toMatchObject({code:"IDEMPOTENCY_CONFLICT"});
  await expect(production.get(root(),id)).rejects.toMatchObject({statusCode:404});
  expect((await production.list(root())).items.some(o=>o.productionOrderId===id)).toBe(false);
  expect((await reporting.list(root())).items.some(o=>o.productionOrderId===id)).toBe(false);
  const board=await dashboard.list(root());
  expect(board.items.some(o=>o.order.productionOrderId===id)).toBe(false);
  expect(board.events.some(e=>e.productionOrderId===id)).toBe(false);
  expect((await closure.todos(root())).some(t=>t.entityId===id)).toBe(false);
  await expect(reporting.report(root(),id,{position:1,businessDate:today(),quantity:1},randomUUID())).rejects.toMatchObject({statusCode:404});
  expect((await database.query("SELECT 1 FROM sourcing_production_orders WHERE production_order_id=$1",[id])).rowCount).toBe(1);
  expect((await database.query("SELECT 1 FROM sourcing_production_reports WHERE production_order_id=$1",[id])).rowCount).toBe(1);
  await expect(database.query("DELETE FROM sourcing_production_exclusions WHERE production_order_id=$1",[id])).rejects.toThrow();
  await expect(database.query("UPDATE sourcing_production_exclusions SET reason='overwrite' WHERE production_order_id=$1",[id])).rejects.toThrow();
  const ordinary=await create(factories[0]!,"ORDINARY");
  await sourcing.deleteByRoot(root("sourcing:delete"),ordinary.sourcingCaseId,randomUUID());
  expect((await production.get(root(),ordinary.productionOrderId)).sourceCaseArchived).toBe(true);
  expect((await dashboard.list(root())).items.some(o=>o.order.productionOrderId===ordinary.productionOrderId)).toBe(true);
 },60000);

});
