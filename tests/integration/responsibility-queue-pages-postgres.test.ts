import {describe,it,expect,beforeAll,afterAll,vi} from "vitest";
import {ResponsibilityDeterminationQueueService} from "../../apps/api/src/rework/responsibility-determination-queue-service.js";
import {OwnFactoryApprovalService} from "../../apps/api/src/rework/own-factory-approval-service.js";
import {ProductionExternalResponsibilityService} from "../../apps/api/src/rework/production-external-responsibility-service.js";
import {ResponsibilityQueueResponseSchema} from "@dx-rework/contracts/responsibility-queue";
import {OwnFactoryApprovalQueueResponseSchema} from "@dx-rework/contracts";
import {ExternalResponsibilityQueueResponseSchema} from "@dx-rework/contracts/external-responsibility";
import {responsibilityQueueFixture} from "../helpers/responsibility-queue-fixture.js";
import {testExecutionConfig} from "../../scripts/test-execution-config.mjs";
vi.setConfig({testTimeout:testExecutionConfig.correctnessTimeoutMs,hookTimeout:testExecutionConfig.correctnessTimeoutMs});
const url=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
(url?describe.sequential:describe.skip)("PERF10 synthetic historical read dataset with current live permission SQL queue pages",()=>{
 let f:Awaited<ReturnType<typeof responsibilityQueueFixture>>;
 let samples:{pending:string[];settled:string[]};
 beforeAll(async()=>{f=await responsibilityQueueFixture(url!);samples=await f.initialize();});
 afterAll(async()=>{await f?.dispose();});
 it("finds authorized pending orders beyond200 with complete totals, literal search and stable15-row pages",async()=>{

  const service=new ResponsibilityDeterminationQueueService(f.database),actor=f.productionActor();
  const first=ResponsibilityQueueResponseSchema.parse(await service.list(actor,{page:1}));
  const second=await service.list(actor,{page:2}),last=await service.list(actor,{page:14});
  expect(first).toMatchObject({page:1,pageSize:15,totalCount:201});expect(first.items).toHaveLength(15);expect(second.items).toHaveLength(15);expect(last.items).toHaveLength(6);
  expect(new Set([...first.items,...second.items].map(x=>x.reworkOrderId)).size).toBe(30);
  expect((await service.list(actor,{page:1,search:"ONLY%_201"})).items.map(x=>x.reworkOrderId)).toEqual([samples.pending[200]!]);
  expect(await service.list(actor,{page:1,search:"%_NO_MATCH"})).toMatchObject({totalCount:0,items:[]});
  expect(await service.list(actor,{page:15})).toMatchObject({page:15,totalCount:201,items:[]});
  expect(await service.list(f.actor(f.ids.merch,["order_merchandiser"],"external_responsibility:view"),{page:1})).toMatchObject({totalCount:0,items:[]});
  const legacy=await service.list(actor);expect(legacy.items).toHaveLength(200);expect(legacy.page).toBeUndefined();
  expect(first.items).toEqual(legacy.items.slice(0,15));
 });
 it("pages historical approval and deduction snapshots without changing amounts, roles or unparameterized clients",async()=>{
  expect(samples.settled).toHaveLength(201);
  const own=new OwnFactoryApprovalService(f.database),owner=f.actor(f.ids.owner,["owner_group"],"own_factory:view","own_factory:approve");
  const approval=OwnFactoryApprovalQueueResponseSchema.parse(await own.listQueue(owner,{page:1}));
  expect(approval).toMatchObject({page:1,pageSize:15,totalCount:201});expect(approval.items).toHaveLength(15);
  const legacyOwn=await own.listQueue(owner);expect(legacyOwn.items).toHaveLength(200);expect(legacyOwn.page).toBeUndefined();expect(approval.items).toEqual(legacyOwn.items.slice(0,15));
  expect((await own.listQueue(owner,{page:1,search:"ONLY%_201"})).items.map(x=>x.reworkOrderId)).toEqual([samples.settled[200]!]);
  expect(await own.listQueue(f.merchActor(),{page:1})).toMatchObject({totalCount:0,items:[]});
  const external=new ProductionExternalResponsibilityService(f.database);
  const first=ExternalResponsibilityQueueResponseSchema.parse(await external.listQueue(f.payablesActor(),{page:1})),second=await external.listQueue(f.payablesActor(),{page:2}),last=await external.listQueue(f.payablesActor(),{page:14});
  expect(first).toMatchObject({page:1,pageSize:15,totalCount:201});expect(first.items).toHaveLength(15);expect(second.items).toHaveLength(15);expect(last.items).toHaveLength(6);
  expect(new Set([...first.items,...second.items].map(x=>x.caseId)).size).toBe(30);
  const legacy=await external.listQueue(f.payablesActor());expect(legacy.items).toHaveLength(201);expect(legacy.page).toBeUndefined();expect(first.items).toEqual(legacy.items.slice(0,15));
  expect(await external.listQueue(f.payablesActor(),{page:1,search:"待扣款"})).toMatchObject({totalCount:201});
  expect((await external.listQueue(f.payablesActor(),{page:1,search:"ONLY%_201"})).items.map(x=>x.reworkOrderId)).toEqual([samples.settled[200]!]);
  expect(first.items.every(x=>Number(x.proposedDeductionAmount)===0.5&&Number(x.actualDeductedAmount)===0&&Number(x.remainingAmount)===0.5)).toBe(true);
  expect(await external.listQueue(f.actor(f.ids.otherMerch,["sample_designer"],"external_responsibility:view"),{page:1})).toMatchObject({totalCount:0,items:[]});
 });
});

