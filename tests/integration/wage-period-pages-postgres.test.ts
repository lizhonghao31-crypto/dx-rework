import {describe,it,expect,beforeAll,afterAll,vi} from "vitest";
import {unzipSync} from "fflate";
import {WageExportService} from "../../apps/api/src/wages/wage-export-service.js";
import {WageService} from "../../apps/api/src/wages/wage-service.js";
import {WagePeriodDetailPageSchema} from "@dx-rework/contracts/wages";
import {wagePageFixture} from "../helpers/wage-page-fixture.js";
import {testExecutionConfig} from "../../scripts/test-execution-config.mjs";
vi.setConfig({testTimeout:testExecutionConfig.correctnessTimeoutMs,hookTimeout:testExecutionConfig.correctnessTimeoutMs});
const url=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
(url?describe:describe.skip)("PERF11 current PostgreSQL wage pages with synthetic historical read rows",()=>{
 let f:Awaited<ReturnType<typeof wagePageFixture>>,service:WageService;
 beforeAll(async()=>{f=await wagePageFixture(url!);service=new WageService(f.db);});
 afterAll(async()=>{await f?.dispose();});
 it("reads only15 rich items per page while matching complete original monetary snapshots and full-period totals",async()=>{
  const full=await service.get(f.reader,f.periodId),first=WagePeriodDetailPageSchema.parse(await service.getPage(f.reader,f.periodId,{page:1})),second=await service.getPage(f.reader,f.periodId,{page:2}),last=await service.getPage(f.reader,f.periodId,{page:3});
  expect(full.items).toHaveLength(33);expect(first).toMatchObject({page:1,pageSize:15,totalCount:33});expect(first.period).toEqual(full.period);expect(first.items).toEqual(full.items.slice(0,15));expect(second.items).toEqual(full.items.slice(15,30));expect(last.items).toEqual(full.items.slice(30));expect(last.period.totalAmount).toBe(full.period.totalAmount);
  expect(new Set([...first.items,...second.items,...last.items].map(x=>x.wageItemId)).size).toBe(33);
  const filtered=await service.getPage(f.reader,f.periodId,{page:1,q:"TEST 普通返工"});expect(filtered.totalCount).toBe(11);expect(filtered.items).toEqual(full.items.filter(x=>x.processNameSnapshot==="TEST 普通返工"));expect(filtered.period).toEqual(full.period);
  expect(await service.getPage(f.reader,f.periodId,{page:1,q:"%_not_any"})).toMatchObject({totalCount:0,items:[]});
  expect(await service.getPage(f.reader,f.periodId,{page:4})).toMatchObject({page:4,totalCount:33,items:[],period:full.period});
 });
 it("keeps the independent complete export after a filtered15-item page read",async()=>{
  await service.getPage(f.reader,f.periodId,{page:1,q:"TEST 普通返工"});
  const result=await new WageExportService(f.db).export(f.reader,f.periodId),files=unzipSync(result.content),sheet=Buffer.from(files["xl/worksheets/sheet1.xml"]!).toString();
  expect((sheet.match(/<row /g)??[]).length).toBeGreaterThan(33);
  expect((sheet.match(/TEST-RW-2026-0826-004/g)??[]).length).toBe(33);
 });
 it("keeps the original persisted financial authority and unknown-period boundaries",async()=>{
  await expect(service.getPage({...f.people.merchandiser!,authorizationCapability:"wage:view",authorizationCapabilities:["wage:view"]},f.periodId,{page:1})).rejects.toMatchObject({statusCode:403});
  await expect(service.getPage(f.reader,"00000000-0000-4000-8000-000000000099",{page:1})).rejects.toMatchObject({statusCode:404});
 });
});
