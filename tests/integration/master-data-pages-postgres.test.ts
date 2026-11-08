import {describe,it,expect,beforeAll,afterAll,vi} from "vitest";
import {PeopleDirectoryPageSchema,PeopleDirectoryQuerySchema,SupplierDirectoryPageSchema,SupplierDirectoryQuerySchema,SUPPLIER_DIRECTORY_TYPE_LABELS} from "@dx-rework/contracts/master-data-pages";
import {filterSupplierDirectory,SUPPLIER_TYPE_LABELS} from "../../apps/web/src/supplier-center-model.js";
import {masterDataPageFixture} from "../helpers/master-data-page-fixture.js";
import {testExecutionConfig} from "../../scripts/test-execution-config.mjs";
vi.setConfig({testTimeout:testExecutionConfig.correctnessTimeoutMs,hookTimeout:testExecutionConfig.correctnessTimeoutMs});
const url=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
(url?describe.sequential:describe.skip)("PERF12 native directory pagination without changing original masking or supplier versions",()=>{
 let f:Awaited<ReturnType<typeof masterDataPageFixture>>;
 beforeAll(async()=>{f=await masterDataPageFixture(url!);});afterAll(async()=>{await f?.dispose();});
 it("selects15 people per group with complete counts and the same original alias and private-field rules",async()=>{
  const full=await f.access.listPeople({includeInactive:true,includeRevokedAliases:true},f.root),matching=full.filter(p=>p.displayName.startsWith("TEST 目录人员"));
  expect(matching).toHaveLength(31);
  const read=(temporaryPage:number)=>f.access.peoplePage(PeopleDirectoryQuerySchema.parse({q:"TEST 目录人员",temporaryPage}),f.root);
  const first=PeopleDirectoryPageSchema.parse(await read(1)),second=await read(2),last=await read(3);
  expect(first).toMatchObject({totalCount:full.length,matchedCount:31,temporary:{page:1,totalCount:31}});expect(first.temporary.items).toEqual(matching.slice(0,15));expect(second.temporary.items).toEqual(matching.slice(15,30));expect(last.temporary.items).toEqual(matching.slice(30));
  const actor=f.people.merchandiser!,maskedFull=await f.access.listPeople({includeInactive:true,includeRevokedAliases:true},actor),masked=await f.access.peoplePage(PeopleDirectoryQuerySchema.parse({q:"TEST 目录人员"}),actor);
  expect(masked.temporary.items).toEqual(maskedFull.filter(p=>p.displayName.startsWith("TEST 目录人员")).slice(0,15));expect(masked.temporary.items.every(p=>p.privateProfileMasked&&p.temporaryPhoneNumber!=="00000000000")).toBe(true);
  expect((await f.access.peoplePage(PeopleDirectoryQuerySchema.parse({q:"TEST目录别名31"}),actor)).temporary.items.map(p=>p.personId)).toEqual([f.personIds[30]]);
  expect((await f.access.peoplePage(PeopleDirectoryQuerySchema.parse({q:"%_NO_MATCH"}),actor)).matchedCount).toBe(0);
 });
 it("matches original supplier filters across all pages and keeps global crafts and independent selected profiles",async()=>{
  expect(SUPPLIER_DIRECTORY_TYPE_LABELS).toEqual(SUPPLIER_TYPE_LABELS);const full=await f.access.listSuppliers(true);
  for(const input of [{q:"TEST 目录供应商",status:"all"},{q:"TEST",type:"fabric",status:"active",completeness:"complete"},{q:"加工厂",status:"all",completeness:"missing"},{q:"",status:"all",craft:"TEST最后页工艺"},{q:"%_NO_MATCH",status:"all"}] as const){
   const query=SupplierDirectoryQuerySchema.parse(input),matching=filterSupplierDirectory(full,{query:query.q,...query}),page=SupplierDirectoryPageSchema.parse(await f.access.supplierPage(query));
   expect(page.totalCount).toBe(matching.length);expect(page.items).toEqual(matching.slice(0,15));expect(page.crafts).toContain("TEST最后页工艺");
  }
  const query=SupplierDirectoryQuerySchema.parse({q:"TEST 目录供应商",status:"all",page:2}),second=await f.access.supplierPage(query),third=await f.access.supplierPage({...query,page:3});expect(second.items).toHaveLength(15);expect(third.items).toHaveLength(1);expect(second.totalCount).toBe(31);
  expect((await f.access.getSupplier(f.supplierIds[0]!)).supplierId).toBe(f.supplierIds[0]);
 });
 it("reflects native alias revocation, deactivation and versioned supplier edits on the next read",async()=>{
  const personId=f.personIds[30]!,person=(await f.access.listPeople({includeInactive:true,includeRevokedAliases:true},f.root)).find(p=>p.personId===personId)!;
  await f.access.revokePersonAlias(f.master,person.aliases[0]!.aliasId,"TEST撤销别名");
  expect((await f.access.peoplePage(PeopleDirectoryQuerySchema.parse({q:"TEST目录别名31"}),f.root)).matchedCount).toBe(0);
  await f.access.deactivatePerson(f.master,personId,"TEST停用人员");
  const inactive=await f.access.peoplePage(PeopleDirectoryQuerySchema.parse({q:"停用"}),f.root);expect(inactive.temporary.items.some(p=>p.personId===personId)).toBe(true);
  const supplierId=f.supplierIds[0]!;await f.access.reviseSupplier(f.root,supplierId,{expectedVersion:1,supplierName:"TEST 保存后新名称",changeReason:"TEST版本修改"});
  const updated=await f.access.supplierPage(SupplierDirectoryQuerySchema.parse({q:"TEST 保存后新名称",status:"all"}));expect(updated.totalCount).toBe(1);expect(updated.items[0]).toMatchObject({supplierId,version:2,supplierName:"TEST 保存后新名称"});
 });
});
