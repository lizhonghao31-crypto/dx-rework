import type {OrderJourney} from '@dx-rework/contracts/digital-production-journey';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {beforeAll,afterAll,describe,it,expect,vi} from 'vitest';
import {DigitalOrderCreateSchema} from '@dx-rework/contracts/digital-production';
import {prepareTimeFrameworkConfiguration} from '@dx-rework/contracts/order-time-settings';
import {supplychainSettingsBrowser} from '../acceptance/supplychain-settings-browser.js';
import {r5OneHourConfiguration} from '../helpers/r5-order-time-fixture.js';
import {OrderTimeSettingsService} from '../../apps/api/src/production-platform/order-time-settings-service.js';
import {OrderTimeRequestService} from '../../apps/api/src/production-platform/order-time-request-service.js';
import {orderTimeNativeExecutor} from '../../apps/api/src/production-platform/order-time-native-commands.js';
import {testExecutionConfig} from '../../scripts/test-execution-config.mjs';
vi.setConfig({testTimeout:testExecutionConfig.correctnessTimeoutMs,hookTimeout:testExecutionConfig.correctnessTimeoutMs});
const url=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
(url?describe.sequential:describe.skip)('PR08 activated original App time framework',()=>{
 let h:Awaited<ReturnType<typeof supplychainSettingsBrowser>>,scene:string;
 const orders:Array<{id:string;style:string;route:'A'|'B'}>=[];
 beforeAll(async()=>{
  h=await supplychainSettingsBrowser(url!,process.env.TIME08_BROWSER_EVIDENCE??join(tmpdir(),'time08-cockpit-'+randomUUID()),{fullApp:true,orderTimeModel:true,orderTimeFlow:true});
  const settings=new OrderTimeSettingsService(h.db),read=await settings.read(h.f.root);
  expect(read.current.framework).toBeDefined();
  await settings.save(h.f.root,{expectedVersion:0,values:prepareTimeFrameworkConfiguration(r5OneHourConfiguration())},randomUUID());
  scene=await h.f.scene('2027-01-07T15:00:00Z');h.setCollectionScene(scene);
  const requests=new OrderTimeRequestService(h.db,orderTimeNativeExecutor(h.db,true,h.patternOrders));
  for(const route of ['A','B'] as const)await h.f.runtime.run(scene,h.f.root,async()=>{
   const designer=h.f.people['sample-designer']!,style='TEST-TIME08-'+route+'-'+randomUUID();
   const input=DigitalOrderCreateSchema.parse({customerCode:'PD',productGroup:'男装',requiresColorMatching:route==='A',designStyleNo:style,orderDate:'2027-01-07',primaryMerchandiserId:h.f.people.merchandiser!.actorId,lines:[{formalPoNo:style+'-PO',color:'黑',customerWarehouseArrivalDate:'2027-02-20',sizes:[{size:'M',quantity:10}]}]});
   const operation={kind:'direct_order' as const,input,route:{craftSteps:[],preshrink:false}},check=await requests.check(designer,operation);
   const pending=await requests.submit(designer,{operation,fingerprint:check.fingerprint,reason:'TEST intermediate milestone gap'},randomUUID());
   const manager=h.f.people.owner!,review=await requests.read(manager,pending.requestId),result=await requests.apply(manager,pending.requestId,{expectedVersion:review.version,fingerprint:review.check.fingerprint,overrides:{},acceptLate:true},randomUUID());
   orders.push({id:result.result!.orderId!,style,route});
  });
 });
 afterAll(async()=>{if(h){await h.writeEvidence();await h.dispose();}});
 it('keeps customer delivery and actual work in separate homepage bars and opens the same original order',async()=>{
  const tab=await h.open(h.f.root.actorId,1165,{},'/ui/digital-cockpit?search=TEST-TIME08-');
  try{
   const page=tab.page;
   await page.getByRole('progressbar',{name:'整单交货日期进度',exact:true}).first().waitFor();
   expect(await page.getByRole('progressbar',{name:'整单交货日期进度',exact:true}).count()).toBe(2);
   expect(await page.getByRole('progressbar',{name:'整单实际进度',exact:true}).count()).toBe(2);
   expect(await page.locator('.cockpit-home-delivery-date').allTextContents()).toEqual(['2027-02-20','2027-02-20']);
   expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
   await page.screenshot({path:join(h.evidence,'home-1165.png'),fullPage:true});
  }finally{await tab.context.close();}
 });
 for(const route of ['A','B'] as const)it('uses '+route+' milestones and original nodes at1165px without duplicate flow cards',async()=>{
  const order=orders.find(row=>row.route===route)!;
  const tab=await h.open(h.f.root.actorId,1165,{},'/ui/digital-cockpit?selected='+order.id);
  try{
   const page=tab.page,flow=page.locator('.cockpit-milestones');await flow.waitFor();
   expect(await flow.locator('.cockpit-stage').count()).toBe(route==='A'?9:8);
   const dto=await page.evaluate(async id=>{const response=await fetch('/api/digital-production/journeys/'+id+'?view=cockpit');if(!response.ok)throw Error('Journey read failed '+response.status);return response.json();},order.id) as OrderJourney;
   await writeFile(join(h.evidence,'event-target-'+route+'.json'),JSON.stringify(dto,null,2));
   for(const node of dto.stages.flatMap(stage=>stage.nodes).filter(node=>node.key==='budget'||node.key==='design_handover')){
    expect(node.actualAt).toBeNull();
    for(const target of node.fixedTargets??[]){
     expect(target.progress.ownSla.deadlineAt).toBeNull();
     if(node.key==='budget')expect(target.progress.goalDelta).toMatchObject({kind:'on_target',targetAt:'2027-01-23T11:00:00.000Z'});
     else expect(target.progress.goalDelta).toMatchObject({kind:'late',targetPrecision:'date',targetDate:route==='A'?'2026-11-17':'2026-12-18',signedValue:route==='A'?51:20});
    }
   }

   const approval=dto.stages.flatMap(stage=>stage.nodes).find(node=>node.key==='customer_sample');
   expect(approval).toMatchObject({expectedAt:'2027-01-07',expectedPrecision:'date'});
   expect(dto.fixedSchedule?.framework?.scopes[0]?.milestones.find(row=>row.key==='client_sample_approval')).toMatchObject({feasibility:'sufficient',lateMinutes:0});
   expect(await page.locator('.cockpit-flow-panel').count()).toBe(1);
   await flow.getByRole('button',{name:'发加工节点明细',exact:true}).click();
   const panel=page.getByRole('region',{name:'小流程明细',exact:true});
   await expect.poll(()=>panel.getByRole('columnheader',{name:'预计完成',exact:true}).count()).toBe(1);
   expect(await panel.getByRole('columnheader',{name:'实际完成',exact:true}).count()).toBe(1);
   expect(await panel.locator('tbody tr').count()).toBeGreaterThan(0);
   expect(await panel.innerText()).not.toContain('受本目标约束');
   expect(await panel.locator('time').first().innerText()).toMatch(/^20\d{2}-\d{2}-\d{2}$/);
   const boxes=await page.locator('.journey-node-panel,.journey-documents-panel,.journey-activity-panel').evaluateAll(elements=>elements.map(element=>{const r=element.getBoundingClientRect();return {top:r.top,left:r.left,right:r.right,bottom:r.bottom};}));
   expect(boxes[0]!.right).toBeGreaterThan(boxes[1]!.right);expect(boxes[1]!.top).toBeGreaterThan(boxes[0]!.top);expect(Math.abs(boxes[1]!.top-boxes[2]!.top)).toBeLessThan(2);expect(Math.abs(boxes[1]!.bottom-boxes[2]!.bottom)).toBeLessThan(2);
   await page.screenshot({path:join(h.evidence,'detail-'+route+'-1165.png'),fullPage:true});
   await flow.getByRole('button',{name:'设计资料交接节点明细',exact:true}).click();
   await panel.getByRole('button',{name:'设计资料交接',exact:true}).waitFor();
   expect(await panel.locator('tbody tr').count()).toBe(1);
   expect(await page.getByRole('region',{name:'当前节点详情',exact:true}).innerText()).toContain('设计资料交接');
   await page.getByRole('button',{name:'本单全部节点',exact:true}).click();
   expect(await panel.locator('tbody tr').count()).toBeGreaterThan(0);
   await page.setViewportSize({width:650,height:900});
   expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
   await page.screenshot({path:join(h.evidence,'detail-'+route+'-650.png'),fullPage:true});
   expect(h.errors).toEqual([]);
  }finally{await tab.page.screenshot({path:join(h.evidence,'last-'+route+'.png'),fullPage:true});await writeFile(join(h.evidence,'last-'+route+'.html'),await tab.page.content());await tab.context.close();}
 });
});
