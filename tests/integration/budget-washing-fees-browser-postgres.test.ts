import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {supplychainSettingsBrowser} from '../acceptance/supplychain-settings-browser.js';
import {r5RoleFixture} from '../helpers/r5-role-fixture.js';
import {CustomerMerchandiserDefaultsService} from '../../apps/api/src/production-platform/customer-merchandiser-defaults.js';
import {adoptBulkWashingWithClient} from '../../apps/api/src/production-platform/bulk-washing-repository.js';
import {DigitalBudgetService} from '../../apps/api/src/production-platform/budget-service.js';
const url=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
(url?describe:describe.skip)('washing fee in the original authenticated budget App',()=>{
 let h:Awaited<ReturnType<typeof supplychainSettingsBrowser>>,primary:Awaited<ReturnType<typeof r5RoleFixture>>,id:string;
 beforeAll(async()=>{
  h=await supplychainSettingsBrowser(url!,join(process.env.RUNNER_TEMP??tmpdir(),'washing-budget-fee-ui-'+randomUUID()),{fullApp:true});
  const f=h.f;primary=await r5RoleFixture(h.db,f.access,{...f.root,requestId:randomUUID()},'order_merchandiser');
  const defaults=new CustomerMerchandiserDefaultsService(h.db),old=(await defaults.selected(f.root,{codes:['PD']})).items[0]!;
  await defaults.save(f.root,{customers:[{code:'PD',expectedVersion:old.version}],primaryMerchandiserId:primary.actor.actorId,secondaryMerchandiserIds:[],mode:'replace'},randomUUID());
  expect(primary.actor.authorizationCapabilities).toContain('sourcing:inquiry:create');
  const ready=await(async()=>{try{return await f.bulkReady('无',undefined,1,undefined,{quantity:4,primaryActor:{...primary.actor,authorizationCapability:'sourcing:inquiry:create'}});}finally{
   const current=(await defaults.selected(f.root,{codes:['PD']})).items[0]!;await defaults.save(f.root,{customers:[{code:'PD',expectedVersion:current.version}],primaryMerchandiserId:old.primary!.id,secondaryMerchandiserIds:old.secondary.map(person=>person.id),mode:'replace'},randomUUID());
  }})();id=ready.id;
  const duration={minutes:60,calendar:'continuous' as const,reminder:{enabled:true,percent:70}},db=await h.db.connect();
  try{await db.query('BEGIN');await adoptBulkWashingWithClient(db,f.root,id,ready.input.lineItems[0]!.lineId!,0,{arrangement:{mode:'after_receipt',accounting:'additional',reference:'TEST original adoption',revision:1,washing:duration,inspection:duration},staff:{logisticsId:f.people['embroidery-washing-merchandiser']!.actorId,inspectorId:f.people.qc!.actorId},fee:{kind:'pending'},sourceRef:'TEST native fee'});await db.query('COMMIT');}finally{db.release();}
 });
 afterAll(async()=>{if(h){await h.writeEvidence();await h.dispose();}});
 it('keeps a lost committed fee response pending and recovers the same original command without a duplicate cost',async()=>{
  const tab=await h.open(primary.actor.actorId,1165,{},`/ui/digital-production?budget=${id}&documentChapter=budget-washing-fees`);
  try{
   const fee=tab.page.locator('#budget-washing-fees');await fee.getByLabel('费用办理',{exact:true}).waitFor();
   await fee.getByLabel('费用办理',{exact:true}).selectOption('new');await fee.getByLabel('洗水单价',{exact:true}).fill('2');await fee.getByLabel('费用依据与原因',{exact:true}).fill('TEST 实际洗水费用，保留原预算合同');
   let first=true;await tab.page.route(`**/orders/${id}/budget/washing-fees`,async route=>{
    if(first&&route.request().method()==='POST'){first=false;const response=await route.fetch();expect(response.status()).toBe(200);await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'TEST_LOST_FEE_ACK',message:'TEST 已提交但应答中断'}})});}else await route.continue();
   });
   await fee.getByRole('button',{name:'发布并关联洗水费用',exact:true}).click();await fee.getByRole('button',{name:'用原内容核对费用提交',exact:true}).waitFor();
   expect((await new DigitalBudgetService(h.db,true).read(h.f.root,id)).version).toBe(3);
   await fee.getByRole('button',{name:'重新读取洗水费用',exact:true}).click();await fee.getByRole('button',{name:'用原内容核对费用提交',exact:true}).waitFor();
   const recovered=tab.page.waitForResponse(response=>response.url().endsWith('/budget/washing-fees')&&response.request().method()==='POST');
   await fee.getByRole('button',{name:'用原内容核对费用提交',exact:true}).click();expect((await recovered).status()).toBe(200);await fee.getByText('当前引用预算 v3',{exact:true}).waitFor();
   expect(await fee.getByRole('alert').count()).toBe(0);
   const writes=h.requests.filter(call=>call.session===tab.session&&call.path.endsWith('/budget/washing-fees')&&call.method==='POST');expect(writes).toHaveLength(2);expect(writes[0]!.key).toBe(writes[1]!.key);expect(writes[0]!.bodyHash).toBe(writes[1]!.bodyHash);
   expect((await h.db.query('SELECT version FROM digital_budget_versions WHERE production_order_id=$1 ORDER BY version',[id])).rows).toEqual([{version:2},{version:3}]);
   expect((await h.db.query("SELECT count(*)::int n FROM audit_events WHERE entity_id=$1 AND action='budget_washing_fee'",[id])).rows[0].n).toBe(1);
   expect((await new DigitalBudgetService(h.db,true).read(h.f.root,id)).totals?.cost).toBe('7');
   await tab.page.screenshot({path:join(h.evidence,'washing-fee-published-1165.png'),fullPage:true});
   await tab.page.getByLabel('查看预算版本',{exact:true}).selectOption('2');await tab.page.getByText('历史预算 v2 只读，不以当前费用替代本版明细。',{exact:true}).waitFor();
   expect(await tab.page.getByRole('button',{name:'发布并关联洗水费用',exact:true}).count()).toBe(0);
  }catch(error){await tab.page.screenshot({path:join(h.evidence,'washing-fee-native-failure.png'),fullPage:true});throw error;}finally{await tab.context.close();}
 });
 it('keeps a same-session revoked publisher and unrelated washing/QC users out of the financial write path',async()=>{
  const tab=await h.open(primary.actor.actorId,390,{},`/ui/digital-production?budget=${id}&documentChapter=budget-washing-fees`);
  try{
   const fee=tab.page.locator('#budget-washing-fees');await fee.getByLabel('费用办理',{exact:true}).waitFor();
   await fee.getByLabel('费用办理',{exact:true}).selectOption('adjust');await fee.getByLabel('洗水单价',{exact:true}).fill('0');await fee.getByLabel('费用依据与原因',{exact:true}).fill('TEST 明确免收费并保留原2元记录');
   await fee.getByRole('button',{name:'发布并关联洗水费用',exact:true}).click();await fee.getByText('当前引用预算 v4',{exact:true}).waitFor();
   expect(await fee.getByRole('alert').count()).toBe(0);
   expect((await new DigitalBudgetService(h.db,true).read(h.f.root,id)).totals?.cost).toBe('5');expect((await new DigitalBudgetService(h.db,true).read(h.f.root,id,undefined,3)).totals?.cost).toBe('7');
   await tab.page.screenshot({path:join(h.evidence,'washing-fee-zero-390.png'),fullPage:true});
   await h.f.access.revokeRole({...h.f.root,requestId:randomUUID()},primary.assignmentId,'TEST same-cookie washing fee revoke');
   await fee.getByRole('button',{name:'重新读取洗水费用',exact:true}).click();await fee.getByRole('alert').waitFor();expect(await fee.getByLabel('费用办理',{exact:true}).count()).toBe(0);
  }finally{await tab.context.close();}
  const foreign=await h.open(h.f.people['embroidery-washing-merchandiser']!.actorId,390,{},`/ui/digital-production?factory=${id}&factoryAction=washing`);
  try{expect((await foreign.page.request.get(h.base+`/api/digital-production/orders/${id}/budget/washing-fees`)).status()).toBe(404);expect(await foreign.page.getByText(/洗水费用：/).count()).toBe(0);}finally{await foreign.context.close();}
 });
});
