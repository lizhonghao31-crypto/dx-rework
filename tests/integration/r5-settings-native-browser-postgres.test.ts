import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {beforeAll,afterAll,describe,it,expect,vi} from 'vitest';
import type {Page,Locator} from 'playwright-core';
import {supplychainSettingsBrowser} from '../acceptance/supplychain-settings-browser.js';
import {r5OneHourConfiguration} from '../helpers/r5-order-time-fixture.js';
import {OrderTimeSettingsService} from '../../apps/api/src/production-platform/order-time-settings-service.js';
import {testExecutionConfig} from '../../scripts/test-execution-config.mjs';

vi.setConfig({testTimeout:testExecutionConfig.correctnessTimeoutMs,hookTimeout:testExecutionConfig.correctnessTimeoutMs});
const url=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
(url?describe.sequential:describe.skip)('R5 original App settings, calculator and customer assignment',()=>{
 let h:Awaited<ReturnType<typeof supplychainSettingsBrowser>>,standards:OrderTimeSettingsService,secondaryA:{id:string},secondaryB:{id:string};
 const ready=async(page:Page)=>{await page.getByRole('button',{name:'保存并使用',exact:true}).waitFor();};
 const edit=async(page:Page,value:string,confirm=true)=>{
  await page.getByRole('navigation',{name:'时效设置阶段'}).getByRole('button',{name:'产品开发打板',exact:true}).click();
  await page.locator('.r5-node-list').getByRole('button',{name:'开发纸样',exact:true}).click();
  const editor=page.getByRole('region',{name:'开发纸样设置'});await editor.getByLabel('开发纸样用时',{exact:true}).fill(value);
  if(confirm)await editor.getByRole('button',{name:'确定',exact:true}).click();
 };
 const selectPerson=async(dialog:Locator,label:string,id:string)=>{
  const name=(await h.db.query('SELECT display_name FROM app_users WHERE id=$1',[id])).rows[0].display_name;
  await dialog.getByRole('combobox',{name:label,exact:true}).fill(name);await dialog.getByRole('option',{name,exact:true}).click();
 };
 beforeAll(async()=>{
  // A future-enabled integration in this owned TEST server only. The ordinary
  // application default remains off until the R5-07 adoption chain is present.
  h=await supplychainSettingsBrowser(url!,process.env.R5_SETTINGS_NATIVE_EVIDENCE??join(process.env.RUNNER_TEMP??tmpdir(),'r5-settings-'+randomUUID()),{fullApp:true,orderTimeModel:true});
  standards=new OrderTimeSettingsService(h.db,true);await standards.save(h.f.root,{expectedVersion:0,values:r5OneHourConfiguration()},randomUUID());
  secondaryA=await h.dedicated('order_merchandiser','TEST 副跟单甲');secondaryB=await h.dedicated('order_merchandiser','TEST 副跟单乙');
  for(let i=1;i<=31;i++)await h.db.query("INSERT INTO digital_production_customers(code,name,product_groups,enabled) VALUES($1,$2,ARRAY['男装'],true)",['TEST-R5-UI-'+String(i).padStart(3,'0'),'TEST 页面客户'+i]);
 });
 afterAll(async()=>{if(h){await h.writeEvidence();await h.dispose();}});
 it('uses the complete App and approved visual hierarchy at1586 and1165, with live hand-countable totals and cancellable node editing',async()=>{
  const {page,context}=await h.open();try{
   await ready(page);expect(await page.getByRole('tab',{name:'时效设置',exact:true}).count()).toBe(1);expect(await page.getByRole('tab',{name:'时效演算',exact:true}).count()).toBe(1);expect(await page.getByRole('tab',{name:'客户跟单',exact:true}).count()).toBe(1);
   expect(await page.getByText('查找节点与版本',{exact:true}).count()).toBe(0);expect(await page.getByText('提醒与缓冲',{exact:true}).count()).toBe(0);
   await expect.poll(()=>page.locator('.r5-span-summary').innerText()).toContain('13小时');
   await edit(page,'2',false);await expect.poll(()=>page.locator('.r5-span-summary').innerText()).toContain('14小时');
   await page.locator('.r5-node-list').getByRole('button',{name:'固定裁板',exact:true}).click();expect(await page.getByLabel('开发纸样用时',{exact:true}).inputValue()).toBe('2');
   await page.getByRole('region',{name:'开发纸样设置'}).getByRole('button',{name:'取消',exact:true}).click();await expect.poll(()=>page.locator('.r5-span-summary').innerText()).toContain('13小时');
   await page.locator('.r5-node-list').getByRole('button',{name:'开发纸样',exact:true}).click();
   for(const width of [1586,1165]){await page.setViewportSize({width,height:992});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);await page.screenshot({path:join(h.evidence,'r5-settings-'+width+'.png'),fullPage:true});}
   expect((await standards.read(h.f.root)).version).toBe(1);
  }finally{await context.close();}
 });
 it('keeps the calculator simple, reads exact temporary thirteen/seventeen hour routes and imports history without writing settings',async()=>{
  const before=(await standards.read(h.f.root)).version,{page,context}=await h.open();try{
   await ready(page);await page.getByRole('tab',{name:'时效演算',exact:true}).click();await page.getByLabel('演算参考时间',{exact:true}).fill('2026-11-02T08:00');await page.getByLabel('演算客户交期1',{exact:true}).fill('2026-11-02');
   await expect.poll(()=>page.locator('.r5-calculation-kpis').innerText()).toContain('13小时');await expect.poll(()=>page.locator('.r5-calculation-kpis').innerText()).toContain('余3小时');
   const calculation=page.getByRole('tabpanel',{name:'时效演算',exact:true});await calculation.locator('.r5-route-fields summary').click();const craft=calculation.locator('.r5-craft-choice').filter({hasText:'大货工艺'});await craft.getByLabel('绣花',{exact:true}).check();await craft.getByLabel('印花',{exact:true}).check();
   await expect.poll(()=>page.locator('.r5-calculation-kpis').innerText()).toContain('17小时');await expect.poll(()=>page.locator('.r5-calculation-kpis').innerText()).toContain('差1小时');
   await page.setViewportSize({width:1586,height:992});await page.screenshot({path:join(h.evidence,'r5-calculator-1586.png'),fullPage:true});
   await page.getByRole('button',{name:'导入历史设置',exact:true}).click();await page.getByLabel('选择历史设置',{exact:true}).selectOption({index:1});await page.getByRole('button',{name:'导入',exact:true}).click();
   await page.getByRole('button',{name:'重新填写',exact:true}).click();await expect.poll(()=>page.locator('.r5-calculation-kpis').innerText()).toContain('13小时');expect((await standards.read(h.f.root)).version).toBe(before);
  }finally{await context.close();}
 });
 it('recovers the same single save after a lost receipt and makes exactly one new standard',async()=>{
  const before=(await standards.read(h.f.root)).version,path='/api/digital-production/order-time-settings/save',{page,context,session}=await h.open(undefined,1440,{losePath:path});try{
   await ready(page);await edit(page,'2');await page.getByRole('button',{name:'保存并使用',exact:true}).click();await page.getByRole('button',{name:'核对上次操作结果',exact:true}).click();await page.getByText('已保存并使用，只用于新订单。',{exact:true}).waitFor();
   const requests=h.requests.filter(r=>r.session===session&&r.path===path);expect(requests).toHaveLength(2);expect(new Set(requests.map(r=>r.key)).size).toBe(1);expect(new Set(requests.map(r=>r.bodyHash)).size).toBe(1);expect((await standards.read(h.f.root)).version).toBe(before+1);
  }finally{await context.close();}
 });
 it('preserves manual changes on a real concurrent standard conflict and does not repeat a known successful save after refresh fails',async()=>{
  const path='/api/digital-production/order-time-settings/save',{page,context,session}=await h.open(undefined,1440,{afterWriteRead:path,readPath:'/api/digital-production/order-time-settings'});try{
   await ready(page);await edit(page,'3');const before=await standards.read(h.f.root),values=structuredClone(before.current);values.nodes.development_sewing={...values.nodes.development_sewing!,minutes:120};await standards.save(h.f.root,{expectedVersion:before.version,values},randomUUID());
   await page.getByRole('button',{name:'保存并使用',exact:true}).click();await page.getByRole('button',{name:'核对新设置并保留修改',exact:true}).click();
   await page.getByRole('button',{name:'保存并使用',exact:true}).click();await page.getByText('操作已成功，刷新失败。请刷新，不要重复保存。',{exact:true}).waitFor();
   const saved=await standards.read(h.f.root);expect(saved.current.nodes.development_pattern?.minutes).toBe(180);expect(saved.current.nodes.development_sewing?.minutes).toBe(120);
   await page.getByRole('button',{name:'刷新',exact:true}).first().click();await page.getByText('当前使用：',{exact:false}).waitFor();expect(h.requests.filter(r=>r.session===session&&r.path===path)).toHaveLength(2);
  }finally{await context.close();}
 });
 it('keeps cross-page customer selection and saves primary plus every secondary after a lost modal receipt',async()=>{
  const path='/api/digital-production/customers/default-merchandisers',{page,context,session}=await h.open(undefined,1586,{losePath:path});try{
   await ready(page);await page.getByRole('tab',{name:'客户跟单',exact:true}).click();await page.getByRole('searchbox',{name:'搜索客户',exact:true}).fill('TEST-R5-UI-');await page.getByLabel('选择客户TEST-R5-UI-001',{exact:true}).check();
   await page.getByRole('button',{name:'下一页',exact:true}).last().click();await page.getByLabel('选择客户TEST-R5-UI-016',{exact:true}).waitFor();await page.getByRole('button',{name:'下一页',exact:true}).last().click();await page.getByLabel('选择客户TEST-R5-UI-031',{exact:true}).check();
   await page.getByRole('button',{name:'批量设置',exact:true}).click();const dialog=page.getByRole('dialog',{name:'批量设置默认跟单',exact:true});await selectPerson(dialog,'主跟单',h.f.people.merchandiser!.actorId);await dialog.getByRole('button',{name:'＋ 新增副跟单',exact:true}).click();await selectPerson(dialog,'副跟单1',secondaryA.id);await dialog.getByRole('button',{name:'＋ 新增副跟单',exact:true}).click();await selectPerson(dialog,'副跟单2',secondaryB.id);
   await page.screenshot({path:join(h.evidence,'r5-customers-dialog-1586.png'),fullPage:true});await dialog.getByRole('button',{name:'保存设置',exact:true}).click();await dialog.getByRole('button',{name:'核对上次保存结果',exact:true}).click();await dialog.waitFor({state:'detached'});
   const requests=h.requests.filter(r=>r.session===session&&r.path===path&&r.method==='POST');expect(requests).toHaveLength(2);expect(new Set(requests.map(r=>r.key)).size).toBe(1);expect(new Set(requests.map(r=>r.bodyHash)).size).toBe(1);
   const related=(await h.db.query('SELECT customer_code,user_id FROM digital_customer_secondary_merchandisers WHERE customer_code=ANY($1::text[]) ORDER BY customer_code,position',[['TEST-R5-UI-001','TEST-R5-UI-031']])).rows;expect(related.map(r=>r.user_id)).toEqual([secondaryA.id,secondaryB.id,secondaryA.id,secondaryB.id]);
   expect(await page.getByLabel('选择客户TEST-R5-UI-031',{exact:true}).isChecked()).toBe(true);await page.screenshot({path:join(h.evidence,'r5-customers-1586.png'),fullPage:true});
  }finally{await context.close();}
 });
 it('keeps PMC truly read-only in the same authenticated App and uses keyboard tabs',async()=>{
  const pmc=await h.dedicated('pmc'),{page,context}=await h.open(pmc.id,1165);try{
   await ready(page);expect(await page.getByRole('button',{name:'保存并使用',exact:true}).isDisabled()).toBe(true);const tab=page.getByRole('tab',{name:'时效设置',exact:true});await tab.focus();await page.keyboard.press('End');expect(await page.getByRole('tab',{name:'客户跟单',exact:true}).getAttribute('aria-selected')).toBe('true');
   expect(await page.getByRole('button',{name:'批量设置',exact:true}).count()).toBe(0);expect(await page.getByRole('button',{name:'设置',exact:true}).count()).toBe(0);
   const status=await page.evaluate(async()=> (await fetch('/api/digital-production/customers/default-merchandisers',{method:'POST',headers:{'content-type':'application/json','idempotency-key':'TEST-pmc-refused'},body:JSON.stringify({customers:[{code:'PD',expectedVersion:0}],primaryMerchandiserId:'00000000-0000-4000-a000-000000000001',secondaryMerchandiserIds:[],mode:'replace'})})).status);expect(status).toBe(403);
  }finally{await context.close();}
 });
 it('records no runtime exceptions in the original App scenarios',()=>{expect(h.errors).toEqual([]);});
});
