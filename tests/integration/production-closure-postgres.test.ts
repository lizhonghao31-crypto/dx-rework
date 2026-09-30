import { ownedPostgresSchema } from "../helpers/owned-postgres-schema.js";
import "./production-analysis-postgres.cases.js";
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
import { CuttingSourceService } from "../../apps/api/src/cutting/cutting-source-service.js";
import { AttachmentService } from "../../apps/api/src/tools/attachments.js";
import { FakeObjectStorage } from "../../apps/api/src/tools/storage.js";
import type { TrustedActorContext } from "../../apps/api/src/tools/repositories.js";
const url=process.env.TEST_DATABASE_URL??process.env.DATABASE_URL;
(url?describe:describe.skip)("SSP09 full-schema dispatch to actual receipt",()=>{
 const schema=ownedPostgresSchema("sourcing"),admin=new pg.Pool({connectionString:url!}),database=new pg.Pool({connectionString:url!,options:`-c search_path=${schema}`});
 const user=randomUUID(),owner=randomUUID(),warehouse=randomUUID();
 const actor=(id:string,roles:string[],capabilities:string[]):TrustedActorContext=>({actorId:id,actorRoles:roles,authorizationCapability:capabilities[0]!,authorizationCapabilities:capabilities,requestId:randomUUID()});
 const root=(capability="sourcing:view")=>actor(user,["root_superuser"],[capability,"sourcing:view","todo:view","receiving:create"]);
 const merch=()=>actor(user,["order_merchandiser"],["sourcing:inquiry:create","sourcing:view","todo:view"]);
 const boss=()=>actor(owner,["owner_group","production_management"],["sourcing:owner:approve","sourcing:view","todo:view"]);
 const receiver=()=>actor(warehouse,["warehouse_receiver"],["receiving:create"]);
 const contracts=new SourcingContractService(database,new AttachmentService(database,new FakeObjectStorage(),{prefix:"tests",ttlSeconds:60,maxUploadBytes:5000000}));
 const projection={actionableForAllAssignedRole:async()=>[],cancelOpenByDedupePrefix:async()=>0,completeOpenByDedupePrefix:async()=>0,information:async()=>undefined};
 const sourcing=new SourcingService(database,undefined,undefined,projection,contracts),production=new SourcingProductionService(database),reporting=new ProductionReportingService(database,undefined,undefined,new ProductionClosureService(database));
 const closure=new ProductionClosureService(database),receiving=new ReceivingService(database,undefined,undefined,closure,{allowLegacyStyleInput:true}),strictReceiving=new ReceivingService(database,undefined,undefined,closure),cutting=new CuttingSourceService(database);
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
  await database.query(`INSERT INTO owner_bootstrap_consumptions(singleton,user_id,provider_user_id,corp_id)
    VALUES(true,$1,$2,'corp')`,[user,`ding-${user}`]);
  craftId=(await access.ensureCrafts(root("master_data:manage"),{craftNames:["车缝＋线＋包装，回厂装箱＋一程运费"]}))[0]!.craftId;
  for(let i=1;i<=3;i++)factories.push((await access.createSupplier(root("supplier_profile:write"),CreateSupplierSchema.parse({supplierCode:`SSP09-${i}`,supplierType:"factory",supplierName:`试点厂${i}`,active:true,changeReason:"SSP09合成验收数据",address:`试点路${i}号`,contractEntityName:`试点厂${i}有限公司`,partyBRepresentative:"试点代表",payeeName:"试点收款人",bankAccount:`62220${i}`,bankName:"测试银行"}))).supplierId);
 },60000);
 afterAll(async()=>{await database.end();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();});
 const readyCuttingSheet=async(uploadedBy:string)=>{const attachmentId=randomUUID();await database.query(
  `INSERT INTO attachments(attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,uploaded_by,status,ready_at)
   VALUES($1,$2,'裁床单.png','image/png',128,$3,$4,'ready',CURRENT_TIMESTAMP)`,
  [attachmentId,`cutting-sheet/${attachmentId}.png`,"d".repeat(64),uploadedBy]);return attachmentId;};
 const create=async(supplierId:string,suffix:string)=>{
  const created=await sourcing.createCase(merch(),{gender:"女装",styleName:"试点上衣",estimatedCutPieceSendDate:today(),deliveryDate:today(),
   lineItems:[{styleNo:`SSP09-${suffix}-A`,color:"蓝",quantity:20,externalUnitPrice:"8.0000"},{styleNo:`SSP09-${suffix}-B`,color:"白",quantity:10,externalUnitPrice:"9.0000"}],daxingUnitPrice:"777.1234"},randomUUID());
  const id=created.value.sourcingCaseId,prices=[{position:1,unitPrice:"8.0000"},{position:2,unitPrice:"9.0000"}];
  await sourcing.quoteIePrice(actor(user,["ie_reviewer"],["sourcing:price:quote","sourcing:view"]),id,{linePrices:prices},randomUUID());
  await sourcing.recordManagementDecision(actor(user,["production_management"],["sourcing:decision:record","sourcing:view"]),id,{supplierId,linePrices:prices,craftIds:[craftId]},randomUUID());
  await sourcing.decideOwner(boss(),id,{decision:"approved"},randomUUID());
  const cuttingOrders=await database.query<{cutting_order_id:string;quantity:number}>(
    `SELECT cutting.cutting_order_id,snapshot_line.quantity
     FROM cutting_orders cutting
     JOIN sourcing_approval_snapshot_lines snapshot_line
       ON snapshot_line.sourcing_approval_snapshot_id=cutting.approval_snapshot_id
      AND snapshot_line.position=cutting.sourcing_line_position
     WHERE cutting.sourcing_case_id=$1
     ORDER BY cutting.sourcing_line_position`,
    [id],
  );
  for(const item of cuttingOrders.rows) {
    const cuttingActor=root("cutting:records:create");
    const cuttingSheet=await readyCuttingSheet(cuttingActor.actorId);
    await cutting.record(cuttingActor,item.cutting_order_id,{
      pieceCount:Number(item.quantity),actualCutCount:Number(item.quantity),attachmentIds:[cuttingSheet],
    },randomUUID());
  }
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
 it("auto-links shipped pilot receipts from the selected cutting order without a second production picker",async()=>{
  const order=await create(factories[1]!,"AUTO-LINK");
  await closure.setPilot(root(),{supplierId:factories[1],enabled:true});
  for(const line of order.lines) await reporting.report(root(),order.productionOrderId,{position:line.position,businessDate:today(),quantity:line.quantity},randomUUID());
  await reporting.execute(root(),order.productionOrderId,"complete",{businessDate:today(),confirmed:true},randomUUID());
  await reporting.execute(root(),order.productionOrderId,"ship",{businessDate:today(),confirmed:true},randomUUID());
  const options=await strictReceiving.listCuttingOptions("NK-A");
  const selected=options.find(item=>item.styleNo==="SSP09-AUTO-LINK-A");
  expect(selected).toMatchObject({actualCutCount:20,supplierName:"试点厂2"});
  const first=await receiving.create(receiver(),{
    styleNo:"SSP09-AUTO-LINK-A",documentQuantity:20,actualQuantity:20,
    attachmentIds:[await readyImage()],
  },randomUUID());
  expect((await database.query("SELECT cutting_order_id FROM receiving_receipts WHERE receipt_id=$1",[first.value.receiptId])).rows[0]!.cutting_order_id)
    .toBe(selected!.cuttingOrderId);
  expect((await database.query("SELECT production_order_id FROM sourcing_production_receipt_links WHERE receipt_id=$1",[first.value.receiptId])).rows[0]!.production_order_id)
    .toBe(order.productionOrderId);
  const repeated=await receiving.createRepeated(receiver(),{
    receivingBatchId:first.value.receivingBatchId,
    source:"jiashun",actualQuantity:1,
  },randomUUID());
  expect((await database.query(
    "SELECT cutting_order_id FROM receiving_receipts WHERE receipt_id=$1",
    [repeated.value.receiptId],
  )).rows[0]!.cutting_order_id).toBe(selected!.cuttingOrderId);
  expect((await closure.receiptSummary(root(),order.productionOrderId)).shipment?.receipts.map(item=>item.receiptId))
    .toEqual([first.value.receiptId,repeated.value.receiptId]);
  expect((await database.query("SELECT actual_cut_count FROM current_receiving_cutting_links WHERE receipt_id=$1",[repeated.value.receiptId])).rows[0]!.actual_cut_count)
    .toBe("20");
  const board=await strictReceiving.board(today(),today(),"SSP09-AUTO-LINK-A","all",1,15);
  expect(board.rows.find(row=>row.styleNo==="SSP09-AUTO-LINK-A")).toMatchObject({
    actualCutCount:20,receiptCount:2,cuttingRecordedBy:"SSP09跟单",
  });
 },60000);

 it("keeps same-style cutting orders in separate receiving batches and repeat options",async()=>{
  const firstOrder=await create(factories[1]!,"SAMECUT-1");
  const secondOrder=await create(factories[2]!,"SAMECUT-2");
  const sharedStyle="SAME-CUT-STYLE";
  await sourcing.reviseStyles(root(),firstOrder.sourcingCaseId,{
    expectedRevision:0,
    lines:firstOrder.lines.map(line=>({
      position:line.position,
      styleNo:line.position===1?sharedStyle:line.styleNo,
      alternateStyleNo:line.alternateStyleNo,
    })),
  },randomUUID());
  await sourcing.reviseStyles(root(),secondOrder.sourcingCaseId,{
    expectedRevision:0,
    confirmedDuplicateStyles:[sharedStyle],
    lines:secondOrder.lines.map(line=>({
      position:line.position,
      styleNo:line.position===1?sharedStyle:line.styleNo,
      alternateStyleNo:line.alternateStyleNo,
    })),
  },randomUUID());
  const options=await strictReceiving.listCuttingOptions("TYLE");
  const firstCut=options.find(item=>item.styleNo===sharedStyle&&item.supplierName==="试点厂2");
  const secondCut=options.find(item=>item.styleNo===sharedStyle&&item.supplierName==="试点厂3");
  expect(firstCut).toMatchObject({styleConflictCount:2});
  expect(secondCut).toMatchObject({styleConflictCount:2});
  const firstReceipt=await strictReceiving.create(receiver(),{
    cuttingOrderId:firstCut!.cuttingOrderId,documentQuantity:10,actualQuantity:10,
    attachmentIds:[await readyImage()],
  },randomUUID());
  const secondReceipt=await strictReceiving.create(receiver(),{
    cuttingOrderId:secondCut!.cuttingOrderId,documentQuantity:11,actualQuantity:11,
    attachmentIds:[await readyImage()],
  },randomUUID());
  expect(secondReceipt.value.receivingBatchId).not.toBe(firstReceipt.value.receivingBatchId);
  const linked=await database.query<{receiving_batch_id:string;cutting_order_id:string}>(
    "SELECT receiving_batch_id,cutting_order_id FROM receiving_batches WHERE receiving_batch_id=ANY($1::uuid[]) ORDER BY receiving_batch_id",
    [[firstReceipt.value.receivingBatchId,secondReceipt.value.receivingBatchId]],
  );
  expect(new Set(linked.rows.map(row=>row.cutting_order_id))).toEqual(
    new Set([firstCut!.cuttingOrderId,secondCut!.cuttingOrderId]),
  );
  const repeatOptions=await strictReceiving.listRepeatOptions("TYLE");
  expect(repeatOptions.filter(item=>item.styleNo===sharedStyle).map(item=>item.cuttingOrderId).sort())
    .toEqual([firstCut!.cuttingOrderId,secondCut!.cuttingOrderId].sort());
  const compatibilityRepeatOptions=await receiving.listRepeatOptions("TYLE");
  expect(compatibilityRepeatOptions.filter(item=>item.styleNo===sharedStyle).map(item=>item.cuttingOrderId).sort())
    .toEqual([firstCut!.cuttingOrderId,secondCut!.cuttingOrderId].sort());
  await cutting.correct(root("cutting:records:correct"),secondCut!.cuttingOrderId,{
    expectedVersion:1,pieceCount:20,actualCutCount:21,reason:"PR04看板读取当前实裁值",
  },randomUUID());
  const board=await strictReceiving.board(today(),today(),sharedStyle,"all",1,15);
  const sharedRows=board.rows.filter(row=>row.styleNo===sharedStyle);
  expect(sharedRows).toHaveLength(2);
  expect(sharedRows.map(row=>row.actualCutCount).sort((a,b)=>(a??0)-(b??0))).toEqual([20,21]);
  expect(sharedRows.every(row=>row.cuttingRecordedBy==="SSP09跟单")).toBe(true);
  expect(sharedRows.every(row=>row.cuttingRecordedAt!==null)).toBe(true);
 },60000);

 it("keeps backfilled receipts before shipment unlinked instead of rolling them back",async()=>{
  const order=await create(factories[1]!,"BACKFILL-LINK");
  await closure.setPilot(root(),{supplierId:factories[1],enabled:true});
  for(const line of order.lines) await reporting.report(root(),order.productionOrderId,{
    position:line.position,businessDate:today(),quantity:line.quantity,
  },randomUUID());
  await reporting.execute(root(),order.productionOrderId,"complete",{businessDate:today(),confirmed:true},randomUUID());
  await reporting.execute(root(),order.productionOrderId,"ship",{businessDate:today(),confirmed:true},randomUUID());
  const selected=(await strictReceiving.listCuttingOptions("NK-A")).find(
    item=>item.styleNo==="SSP09-BACKFILL-LINK-A",
  )!;
  const yesterday=shanghaiDay(new Date(Date.now()-86400000));
  const receipt=await strictReceiving.create(receiver(),{
    cuttingOrderId:selected.cuttingOrderId,documentQuantity:20,actualQuantity:20,
    attachmentIds:[await readyImage()],receivedDate:yesterday,
  },randomUUID());
  expect(receipt.value.styleNo).toBe("SSP09-BACKFILL-LINK-A");
  expect((await database.query(
    "SELECT 1 FROM sourcing_production_receipt_links WHERE receipt_id=$1",
    [receipt.value.receiptId],
  )).rowCount).toBe(0);
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

 it("preserves shipment and receipt links through style corrections before and after shipping",async()=>{
  const order=await create(factories[2]!,"STYLELINK"),oldStyle=order.firstStyleNo;
  await closure.setPilot(root(),{supplierId:factories[2],enabled:true});
  const lines=order.lines.map(line=>({position:line.position,styleNo:line.position===1?"SHIP-NEW-STYLE":line.styleNo,alternateStyleNo:line.alternateStyleNo}));
  await sourcing.reviseStyles(root(),order.sourcingCaseId,{expectedRevision:0,lines},randomUUID());
  await reporting.report(root(),order.productionOrderId,{position:1,businessDate:today(),quantity:10},randomUUID());
  await reporting.execute(root(),order.productionOrderId,"complete",{businessDate:today(),confirmed:true},randomUUID());
  const shipped=await reporting.execute(root(),order.productionOrderId,"ship",{businessDate:today(),confirmed:true},randomUUID());
  expect(shipped.value.shipment?.firstStyleNo).toBe("SHIP-NEW-STYLE");
  await sourcing.reviseStyles(root(),order.sourcingCaseId,{expectedRevision:1,lines:lines.map(line=>({...line,styleNo:line.position===1?"RECEIPT-NEW-STYLE":line.styleNo}))},randomUUID());
  for(const q of [oldStyle,"SHIP-NEW-STYLE","RECEIPT-NEW-STYLE"]) expect((await closure.expected(receiver(),{q})).items).toContainEqual(expect.objectContaining({productionOrderId:order.productionOrderId,firstStyleNo:"RECEIPT-NEW-STYLE"}));
  for(const styleNo of ["RECEIPT-NEW-STYLE",oldStyle]) {
   await receiving.create(receiver(),{styleNo,documentQuantity:5,actualQuantity:5,attachmentIds:[await readyImage()],productionOrderId:order.productionOrderId},randomUUID());
  }
  const summary=(await closure.receiptSummary(root(),order.productionOrderId)).shipment!;
  expect(summary).toMatchObject({firstStyleNo:"RECEIPT-NEW-STYLE",expectedQuantity:10});
  expect(summary.receipts).toHaveLength(2);
  expect((await production.get(root(),order.productionOrderId)).lines[0]?.quantity).toBe(order.lines[0]?.quantity);
 });
 it("serializes competing style corrections without losing a revision",async()=>{
  const order=await create(factories[2]!,"STYLE-RACE");
  const outcomes=await Promise.allSettled(["RACE-A","RACE-B"].map(styleNo=>sourcing.reviseStyles(root(),order.sourcingCaseId,{expectedRevision:0,lines:order.lines.map(line=>({position:line.position,styleNo:line.position===1?styleNo:line.styleNo,alternateStyleNo:line.alternateStyleNo}))},randomUUID())));
  expect(outcomes.filter(result=>result.status==="fulfilled")).toHaveLength(1);
  expect(outcomes.filter(result=>result.status==="rejected")).toHaveLength(1);
  expect((await sourcing.getCase(root(),order.sourcingCaseId)).identityRevision).toBe(1);
  expect((await contracts.getCurrent(root(),order.sourcingCaseId)).item?.contractVersion).toBe(2);
 });

});