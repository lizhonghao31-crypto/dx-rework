import { ownedPostgresSchema } from "../helpers/owned-postgres-schema.js";
import { readProductionDays } from "../../apps/api/src/sourcing/production-chase.js";
import {randomUUID} from "node:crypto";
import pg from "pg";
import {afterAll,beforeAll,describe,expect,it} from "vitest";
import {ProductionAnalysisQuerySchema,type SourcingProductionOrder} from "@dx-rework/contracts";
import {readProductionAnalysis} from "../../apps/api/src/sourcing/production-analysis.js";
const url=process.env.TEST_DATABASE_URL??process.env.DATABASE_URL;
(url?describe:describe.skip)("production analysis PostgreSQL facts",()=>{
  const schema=ownedPostgresSchema("sourcing"),admin=new pg.Pool({connectionString:url!}),database=new pg.Pool({connectionString:url!,options:`-c search_path=${schema}`});
  const actor={actorId:randomUUID(),actorRoles:["root_superuser"],authorizationCapability:"production-reporting",requestId:randomUUID()};
  const supplierA=randomUUID(),supplierB=randomUUID(),batch=randomUUID(),shared=randomUUID(),archived=randomUUID(),receipt=randomUUID(),correction=randomUUID(),alert=randomUUID();
  const orders:SourcingProductionOrder[]=Array.from({length:20},(_,index)=>({productionOrderId:randomUUID(),sourcingCaseId:randomUUID(),sourceCaseArchived:index===19,
    decisionVersion:1,sourcingContractDocumentId:randomUUID(),contractNumber:`HT-${index}`,contractVersion:1,supplierId:index%2?supplierB:supplierA,supplierName:"同名供应商",
    gender:null,styleName:null,quantity:100,completedQuantity:40,processes:[],deliveryDate:index===2?null:index%2?"2026-09-06":"2026-09-10",firstStyleNo:`STYLE-${index}`,
    dispatchedBy:actor.actorId,dispatchedAt:"2026-09-01T00:00:00Z",status:index===0?"shipped":index===1?"production_completed":"in_production",
    firstReportedOn:"2026-09-02",reportingState:null,timeProgress:null,progressAlert:null,
    lines:[{position:1,styleNo:`STYLE-${index}`,alternateStyleNo:null,color:"蓝",quantity:100,completedQuantity:40}]}));
  const read=async(input:unknown={},reader=actor,visible=orders)=>{const client=await database.connect();try{await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");const result=await readProductionAnalysis(client,visible,reader,"2026-09-07T07:00:00Z",ProductionAnalysisQuerySchema.parse(input));await client.query("COMMIT");return result;}finally{client.release();}};
  beforeAll(async()=>{
    await admin.query(`CREATE SCHEMA ${schema}`);
    await database.query("SET TIME ZONE 'UTC'");
    await database.query(`CREATE TABLE receiving_batches(receiving_batch_id uuid PRIMARY KEY,deleted_at timestamptz,actual_quantity_adjustment bigint DEFAULT 0);
      CREATE TABLE receiving_receipts(receipt_id uuid PRIMARY KEY,receiving_batch_id uuid,received_at timestamptz,actual_quantity bigint);
      CREATE TABLE receiving_receipt_corrections(correction_id uuid,receipt_id uuid,actual_quantity bigint,created_at timestamptz);
      CREATE TABLE sourcing_production_receipt_links(receipt_id uuid PRIMARY KEY,production_order_id uuid);
      CREATE TABLE sourcing_production_exclusions(production_order_id uuid PRIMARY KEY);
      CREATE TABLE sourcing_production_orders(production_order_id uuid PRIMARY KEY);
      CREATE TABLE sourcing_production_transitions(production_order_id uuid,status text,business_date date,created_at timestamptz,sequence int);
      CREATE TABLE sourcing_production_shipments(production_order_id uuid PRIMARY KEY,shipped_on date,created_at timestamptz,recorded_quantity int);
      CREATE TABLE sourcing_production_alerts(production_order_id uuid,alert_id uuid PRIMARY KEY,kind text,opened_at timestamptz,resolved_at timestamptz);
      CREATE TABLE sourcing_production_alert_reads(alert_id uuid,user_id uuid,read_at timestamptz);
      CREATE TABLE sourcing_production_reports(production_order_id uuid,report_id uuid,created_at timestamptz,business_date date,root_report_id uuid,revision int DEFAULT 1,quantity int DEFAULT 0);
      CREATE TABLE rework_orders(rework_order_id uuid,rework_no text,rework_quantity bigint,status text,source_receiving_batch_id uuid);`);
    for(const order of orders)await database.query("INSERT INTO sourcing_production_orders VALUES($1)",[order.productionOrderId]);
    await database.query("INSERT INTO receiving_batches VALUES($1,NULL,-5),($2,NULL,0),($3,'2026-09-06',0)",[batch,shared,archived]);
    const second=randomUUID(),third=randomUUID(),fourth=randomUUID(),fifth=randomUUID();
    await database.query("INSERT INTO receiving_receipts VALUES($1,$2,'2026-09-04',70),($3,$2,'2026-09-05',30),($4,$5,'2026-09-04',10),($6,$5,'2026-09-05',10),($7,$8,'2026-09-03',5)",[receipt,batch,second,third,shared,fourth,fifth,archived]);
    for(const [r,o] of [[receipt,orders[0]!.productionOrderId],[second,orders[0]!.productionOrderId],[third,orders[2]!.productionOrderId],[fourth,orders[3]!.productionOrderId],[fifth,orders[0]!.productionOrderId]])await database.query("INSERT INTO sourcing_production_receipt_links VALUES($1,$2)",[r,o]);
    await database.query("INSERT INTO receiving_receipt_corrections VALUES($1,$2,65,'2026-09-06')",[correction,receipt]);
    await database.query("INSERT INTO sourcing_production_transitions VALUES($1,'production_completed','2026-09-03','2026-09-03',2)",[orders[0]!.productionOrderId]);
    await database.query("INSERT INTO sourcing_production_shipments VALUES($1,'2026-09-04','2026-09-04',90)",[orders[0]!.productionOrderId]);
    await database.query("INSERT INTO sourcing_production_alerts VALUES($1,$2,'behind','2026-09-02',NULL)",[orders[0]!.productionOrderId,alert]);
    await database.query("INSERT INTO sourcing_production_alert_reads VALUES($1,$2,'2026-09-02')",[alert,actor.actorId]);
    await database.query("INSERT INTO sourcing_production_reports(production_order_id,report_id,created_at,business_date) VALUES($1,$2,'2026-09-03','2026-09-02')",[orders[0]!.productionOrderId,randomUUID()]);
    for(const source of [batch,batch,shared])await database.query("INSERT INTO rework_orders VALUES($1,'RW-TEST',10,'completed',$2)",[randomUUID(),source]);
  });
  afterAll(async()=>{await database.end();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();});
  it("uses latest report revisions and sums real daily records for chasing",async()=>{
    const id=randomUUID(),root=randomUUID(),other=randomUUID();
    await database.query("INSERT INTO sourcing_production_reports(production_order_id,root_report_id,revision,quantity,business_date,created_at) VALUES($1,$2,1,100,'2026-09-08','2026-09-08'),($1,$2,2,80,'2026-09-08','2026-09-09'),($1,$3,1,20,'2026-09-08','2026-09-08')",[id,root,other]);
    const client=await database.connect();
    try{const days=await readProductionDays(client,[id],"2026-09-10T00:00:00Z");expect(days.get(id)).toEqual([{day:"2026-09-08",quantity:100}]);}
    finally{client.release();await database.query("DELETE FROM sourcing_production_reports WHERE production_order_id=$1",[id]);}
  });
  it("aggregates all 20 visible orders before pagination and keeps same-name suppliers separate",async()=>{
    const result=await read();expect(result.items).toHaveLength(15);expect(result.summary).toMatchObject({totalCount:20,openCount:18,remainingQuantity:"1080",missingDueCount:1,qualityOrderCount:2});
    expect(result.groupTotal).toBe(2);expect(new Set(result.groups.map(group=>group.supplierId)).size).toBe(2);
    const page=await read({page:2});expect(page.items).toHaveLength(5);expect(page.summary).toEqual(result.summary);
    expect([...page.items,...result.items].some(item=>item.order.sourceCaseArchived)).toBe(true);
  });
  it("separates shipment, receipt correction and archived facts without summing rework quantities",async()=>{
    const item=(await read({},actor,[orders[0]!])).items[0]!;
    expect(item).toMatchObject({receivedQuantity:"95",shippedQuantity:"90",receivingState:"quantity_met",archivedReceiptCount:1,unallocatedBatchCount:0});
    expect(item.firstReceivedAt).toBe("2026-09-04T00:00:00.000Z");expect(item.shippedOn).toBe("2026-09-04");expect(item.receipts.find(row=>row.receiptId===receipt)?.correctionId).toBe(correction);
    expect(item.quality?.reworkOrderCount).toBe(2);expect(item.quality?.orders.map(row=>row.quantity)).toEqual(["10","10"]);
  });
  it("does not turn unallocated batch adjustments into a completed receipt claim",async()=>{
    await database.query("UPDATE receiving_batches SET actual_quantity_adjustment=-10 WHERE receiving_batch_id=$1",[batch]);
    const result=await read({},actor,[orders[0]!]);expect(result.items[0]?.receivingState).toBe("unverified");expect(result.summary.ordersWithUnallocatedAdjustments).toBe(1);
    await database.query("UPDATE receiving_batches SET actual_quantity_adjustment=-5 WHERE receiving_batch_id=$1",[batch]);
  });
  it("does not assign shared-batch rework to either supplier order",async()=>{
    const result=await read({},actor,[orders[2]!,orders[3]!]);expect(result.summary.qualityOrderCount).toBe(0);expect(result.items.every(item=>item.quality?.ambiguousBatchCount===1)).toBe(true);
  });
  it("keeps first observation and read state distinct from resolution and later production",async()=>{
    const item=(await read({},actor,[orders[0]!])).items[0]!.alerts[0]!;
    expect(item).toMatchObject({firstObservedAt:"2026-09-02T00:00:00.000Z",closedAt:null,readAt:"2026-09-02T00:00:00.000Z",nextReportAt:"2026-09-03T00:00:00.000Z",nextReportBusinessDate:"2026-09-02"});
  });
  it("does not expose quality to production reporters or records outside authorized scope",async()=>{
    const result=await read({}, {...actor,actorId:randomUUID(),actorRoles:["production_reporter"]},[orders[0]!]);
    expect(result.summary.totalCount).toBe(1);expect(result.summary.qualityOrderCount).toBeNull();expect(result.items[0]?.quality).toBeNull();expect(result.items[0]?.alerts[0]?.readAt).toBeNull();expect(JSON.stringify(result)).not.toContain(orders[2]!.productionOrderId);
  });
  it("closed orders have no remaining production quantity and absent receipts are not fabricated",async()=>{
    const result=await read({status:"production_completed"});expect(result.summary.remainingQuantity).toBe("0");expect(result.items[0]?.receivingState).toBe("none");expect(result.items[0]?.firstReceivedAt).toBeNull();
  });
});
