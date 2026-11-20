import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {testExecutionConfig} from '../../scripts/test-execution-config.mjs';
import {cockpitHomeBrowser,homeReady} from '../acceptance/m01-cockpit-home-native-browser.js';
import type {OrderJourney} from '@dx-rework/contracts/digital-production-journey';
import {DigitalJourneyQuery} from '../../apps/api/src/production-platform/journey-query.js';
import {DigitalOrderCreateSchema} from '@dx-rework/contracts/digital-production';
import {initialInstruction} from '@dx-rework/contracts/production-instruction';
import {businessNow} from '../../apps/api/src/acceptance-clock/business-time.js';
import {DigitalProductionIdentityService} from '../../apps/api/src/production-platform/identity-service.js';
import {ProductionInstructionService} from '../../apps/api/src/production-platform/production-instruction-service.js';
import {readCockpitInstructionActions} from '../../apps/api/src/production-platform/cockpit-actionable.js';

vi.setConfig({testTimeout:testExecutionConfig.correctnessTimeoutMs,hookTimeout:testExecutionConfig.correctnessTimeoutMs});
const url=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
const scale=process.env.DX_JOURNEY_SCALE==='5000'?5000:process.env.DX_JOURNEY_SCALE==='1000'?1000:31;
if(process.env.DX_JOURNEY_SCALE&&!['1000','5000'].includes(process.env.DX_JOURNEY_SCALE))throw Error('Only explicitly bounded owned TEST scales are supported');
(url?describe.sequential:describe.skip)('PERF03 original full application with indexed page reads and real signed PostgreSQL identity',()=>{
 let h:Awaited<ReturnType<typeof cockpitHomeBrowser>>;
 beforeAll(async()=>{h=await cockpitHomeBrowser({databaseUrl:url!,indexed:true,mixedNative:true,orderCount:scale,evidence:join(process.env.M01_SETTINGS_NATIVE_EVIDENCE??tmpdir(),'journey-page-'+scale+'-'+randomUUID()),...(process.env.M01_SETTINGS_BROWSER_EXECUTABLE?{executablePath:process.env.M01_SETTINGS_BROWSER_EXECUTABLE}:{})});if(scale>31||process.env.DX_JOURNEY_SCALE_SMOKE==='1')await h.measureScale();},scale===5000?1200000:scale===1000?600000:testExecutionConfig.correctnessTimeoutMs);
 afterAll(async()=>{await h?.dispose();});
 it('renders current15 rows, preserves complete global totals across pages and opens the native detail',async()=>{
  const {context,page}=await h.open();try{
   const first=await h.read(page);expect(first.total).toBe(scale);expect(first.items).toHaveLength(15);expect(first.freshness).toBeUndefined();
   if(scale>31){const timing=await page.evaluate(()=>({navigation:performance.getEntriesByType('navigation').map(entry=>entry.toJSON()),resources:performance.getEntriesByType('resource').filter(entry=>entry.name.includes('/api/digital-production/journeys')).map(entry=>entry.toJSON())}));await writeFile(join(h.evidence,'scale-browser-navigation.json'),JSON.stringify({fixtureOrders:scale,context:'Original complete-App IIFE fixture on owned loopback TEST; not production bundles or onsite latency',...timing},null,2)+'\n');}
   const next=page.getByRole('button',{name:'下一页',exact:true});
   // Native notifications remain enabled. Acknowledge an actually displayed
   // notice if it covers the footer; never force a click through the product UI.
   for(let attempt=0;attempt<8;attempt++){
    try{await next.click({timeout:1500});break;}
    catch(error){const notice=page.locator('[aria-label="站内提醒"]');if(!await notice.isVisible()||attempt===7)throw error;await notice.getByRole('button',{name:'我知道了',exact:true}).click();}
   }
   await homeReady(page);expect(new URL(page.url()).searchParams.get('page')).toBe('2');const second=await h.read(page,{page:'2'});
   expect(second.total).toBe(scale);expect(second.summary).toEqual(first.summary);expect(second.items).toHaveLength(15);expect(second.items.every(item=>!first.items.some(value=>value.id===item.id))).toBe(true);
   await expect.poll(()=>page.locator('.journey-orders tbody tr').evaluateAll(rows=>rows.map(row=>(row as HTMLElement).dataset.orderId)),{timeout:12000}).toEqual(second.items.map(item=>item.id));
   await page.locator('.journey-orders tbody tr').first().locator('.journey-order-select').click();await page.locator('[data-view=order][aria-busy=false]').waitFor();expect(await page.locator('.cockpit-stage').count()).toBe(7);
  }finally{await context.close();}
 });
 it('reads native creation and complete cockpit counters from existing indexed facts through the signed API',async()=>{
  const {context,page}=await h.open();try{
   const snapshot=await h.read(page);
   expect(snapshot.summary?.todo).toEqual(expect.any(Number));
   const todo=await h.read(page,{kpi:'todo'});
   expect(todo.total).toBe(snapshot.summary?.todo);
   const order=snapshot.items.find(item=>item.cockpitCreation?.orderCreatedAt);
   expect(order?.orderId).toBeTruthy();
   expect(order?.cockpitFacts).toHaveProperty('production');
   expect(order?.cockpitFacts).toHaveProperty('receiving');
   expect(order?.cockpitFacts).toHaveProperty('shipSample');
   if(!order)throw Error('Missing visible native order');
   const response=await page.request.get(`${h.base}/api/digital-production/journeys/${order.id}?view=cockpit`);
   expect(response.status(),await response.text()).toBe(200);
   const detail=await response.json() as OrderJourney;
   expect(detail).toMatchObject({id:order.id,cockpitCreation:order.cockpitCreation,display:{mainState:order.display?.mainState}});
  }finally{await context.close();}
 });
 it('enters and exits the current instruction action only around the original eligible publication',async()=>{
  const query=new DigitalJourneyQuery(h.fixture.db);
  let before=false;
  const prepared=await h.runInScene(()=>h.fixture.bulkReady('无',undefined,1,h.fixture.sourcing,{beforeInstructionPublish:async orderId=>{
    const detail=await query.read(h.fixture.root,orderId,undefined,true);
    const action=detail.actionableTodo?.items.find(item=>item.category==='instruction_publish');
    expect(action).toMatchObject({handlerId:h.fixture.people.merchandiser!.actorId,
      originalRoute:'/ui/digital-production?instruction='+orderId});
    before=true;
  }}));
  expect(before).toBe(true);
  const after=await query.read(h.fixture.root,prepared.id,undefined,true);
  expect(after.actionableTodo?.items.some(item=>item.category==='instruction_publish')).toBe(false);
 });
 it('batches the native draft prerequisites for one and eight authorized candidates in one PostgreSQL snapshot',async()=>{
  const {db,root,people}=h.fixture,primary=people.merchandiser!;
  const candidates=await h.runInScene(async()=>{
    const identities=new DigitalProductionIdentityService(db,true),instructions=new ProductionInstructionService(db,true);
    const data:Array<{id:string;orderId:string;asOf:string}>=[];
    for(let index=0;index<8;index++){
      const order=(await identities.createOrder(root,DigitalOrderCreateSchema.parse({
        customerCode:'PD',productGroup:'男装',designStyleNo:`TEST-COCKPIT-BATCH-${index}`,orderDate:businessNow().toISOString().slice(0,10),
        primaryMerchandiserId:primary.actorId,lines:[{formalPoNo:`TEST-BATCH-PO-${index}`,color:'黑',
          customerWarehouseArrivalDate:'2027-03-01',sizes:[{size:'M',quantity:20}]}]
      }),randomUUID()));
      await instructions.save(primary,order.productionOrderId,{expectedVersion:0,orderVersion:order.version,document:{
        ...initialInstruction(),styleName:'TEST 批量制单',category:'上衣',date:businessNow().toISOString().slice(0,10),preshrink:'无需预缩',
        sizes:['M'],measurements:[{id:randomUUID(),name:'袖长',tolerance:'±1/4',method:'平量',values:['6']}],
        images:[{attachmentId:await h.fixture.image(primary),kind:'款图',description:'TEST'}]
      }},randomUUID());
      data.push({id:order.productionOrderId,orderId:order.productionOrderId,asOf:businessNow().toISOString()});
    }
    return data;
  });
  const transaction=await db.connect(),statements:string[]=[];
  const counted=new Proxy(transaction,{get(target,key){
    if(key==='query')return (sql:string,args:unknown[])=>{statements.push(sql);return target.query(sql,args);};
    const value:unknown=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
  }});
  try{
    await transaction.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const small=await readCockpitInstructionActions(db,counted,root,candidates.slice(0,1));
    const one=statements.splice(0);
    const many=await readCockpitInstructionActions(db,counted,root,candidates);
    // Both use the original native technical prerequisites, not a bypass
    // for complete-looking drafts whose orders lack the required adoption facts.
    expect(one.some(statement=>statement.includes('digital_development')||statement.includes('digital_preparation_rule_adoptions'))).toBe(true);
    expect(many).toEqual(small);
    expect(statements.some(statement=>statement.includes('__dx_cockpit_candidate')&&statement.includes(' UNION ALL '))).toBe(true);
    expect(statements.length).toBeLessThanOrEqual(one.length+2);
    console.log(`Cockpit native readiness SQL: one=${one.length}, eight=${statements.length}`);
  }finally{await transaction.query('ROLLBACK');transaction.release();}
 });
 it('keeps the signed no-scope search usable when an unrelated order projection fails',async()=>{
  const {context,page}=await h.open();
  const prototype=DigitalJourneyQuery.prototype as unknown as {project(...args:unknown[]):Promise<OrderJourney|null>};
  const original=prototype.project,excluded=h.orders[0]!,matched=h.orders[1]!,visits:string[]=[];
  const spy=vi.spyOn(prototype,'project').mockImplementation(async function(this:unknown,...args:unknown[]){
   const row=args[2] as {order?:{production_order_id:string}};
   if(row.order){visits.push(row.order.production_order_id);if(row.order.production_order_id===excluded)throw Error('TEST excluded order projection failed');}
   return original.apply(this,args);
  });
  try{
   const path=h.base+'/api/digital-production/journeys?';
   const response=await page.request.get(path+new URLSearchParams({search:matched,page:'1'}));
   expect(response.status(),await response.text()).toBe(200);
   expect(await response.json()).toMatchObject({total:1,items:[{orderId:matched}]});
   expect(new Set(visits)).toEqual(new Set([matched]));
   expect((await page.request.get(path+new URLSearchParams({search:excluded,page:'1'}))).status()).toBe(500);
  }finally{spy.mockRestore();await context.close();}
 });
 it('keeps available orders usable while a real derived-object failure hides uncertain totals, pagination and false empty states',async()=>{
  const {context,page}=await h.open();const target=h.orders[0]!,search=(await h.fixture.db.query<{po_number:string}>('SELECT po_number FROM digital_production_po_lines WHERE production_order_id=$1 ORDER BY position LIMIT 1',[target])).rows[0]!.po_number;try{
   await h.corruptProjection(target);await page.getByRole('button',{name:'刷新数据',exact:true}).click();
   await page.getByRole('alert').filter({hasText:'1 单信息更新失败'}).waitFor();
   expect(await page.locator('.journey-orders tbody tr').count()).toBe(15);
   expect(await page.locator('.journey-kpis').innerText()).toContain('—');expect(await page.getByRole('navigation',{name:'分页',exact:true}).count()).toBe(0);
   expect(await page.getByText('当前授权和筛选范围没有订单。',{exact:true}).count()).toBe(0);
   await page.goto(h.base+h.path({search:'TEST-R3-HOME-01'}));await page.getByRole('alert').filter({hasText:'1 单信息更新失败'}).waitFor();
   const overlapping=await h.read(page,{search:'TEST-R3-HOME-01'});expect(overlapping.items.length).toBeGreaterThan(0);expect(overlapping.items.every(item=>item.orderId!==target)).toBe(true);
   await expect.poll(()=>page.locator('.journey-orders tbody tr').evaluateAll(rows=>rows.map(row=>(row as HTMLElement).dataset.orderId))).toEqual(overlapping.items.map(item=>item.id));
   // The original style keyword is a substring, so a healthy shared-prefix
   // mother must remain visible. Only this actual PO uniquely selects the
   // failed object and can independently prove the empty-but-uncertain state.
   await page.goto(h.base+h.path({search}));await page.getByRole('alert').filter({hasText:'1 单信息更新失败'}).waitFor();
   expect(await page.locator('.journey-orders tbody tr').count()).toBe(0);expect(await page.getByText('当前授权和筛选范围没有订单。',{exact:true}).count()).toBe(0);
   await page.getByRole('button',{name:'重试更新失败订单',exact:true}).click();
   await expect.poll(async()=>(await h.read(page,{search})).total,{timeout:12000}).toBe(1);
   await page.getByRole('button',{name:'刷新数据',exact:true}).click();await homeReady(page);expect((await h.read(page,{search})).total).toBe(1);
  }finally{await h.repairProjection(target);await context.close();}
 });
 it('keeps reliable global KPI, true second page and pagination when one selected display read fails',async()=>{
  const {context,page}=await h.open(),prototype=DigitalJourneyQuery.prototype as unknown as {project(...args:unknown[]):Promise<OrderJourney|null>},original=prototype.project;
  let spy:ReturnType<typeof vi.spyOn>|undefined;
  try{
   await page.goto(h.base+h.path({page:'2'}));await homeReady(page);const before=await h.read(page,{page:'2'}),target=before.items[0]!.orderId!;
   spy=vi.spyOn(prototype,'project').mockImplementation(async function(this:unknown,...args:unknown[]){const row=args[2] as {order?:{production_order_id:string}};if(row.order?.production_order_id===target)throw Error('TEST selected display dependency failed');return original.apply(this,args);});
   await page.getByRole('button',{name:'刷新数据',exact:true}).click();await page.getByRole('alert').filter({hasText:'1 单详情暂未读到'}).waitFor();
   const after=await h.read(page,{page:'2'});expect(after.page).toBe(2);expect(after.total).toBe(scale);expect(after.summary).toEqual(before.summary);expect(after.freshness).toMatchObject({failed:1,detailsOnly:true});
   expect(after.items.map(item=>item.id)).toEqual(before.items.filter(item=>item.orderId!==target).map(item=>item.id));
   expect(await page.locator('.journey-orders tbody tr').count()).toBe(14);expect(await page.getByRole('navigation',{name:'分页',exact:true}).count()).toBe(1);
   expect(await page.locator('.journey-kpis .dx-production-kpi strong').allTextContents()).toEqual(
    [before.summary.all,before.summary.active,before.summary.dueSoon,before.summary.overdue,before.summary.completed,before.summary.todo].map(value=>String(value??'—')));
  }finally{spy?.mockRestore();await context.close();}
 });
 it('rechecks the real same valid PMC session after native revocation instead of trusting a cached manager projection',async()=>{
  const {context,page}=await h.open(h.pmcId);try{
   expect((await h.read(page)).total).toBe(scale);await h.revokePmc();
   const me=await page.request.get(h.base+'/api/auth/me');expect(me.status()).toBe(200);
   const response=await page.request.get(h.base+'/api/digital-production/journeys?scope=production');expect([403,404]).toContain(response.status());
   const retry=await page.request.post(h.base+`/api/digital-production/journeys/${h.orders[0]}/refresh`);expect([403,404]).toContain(retry.status());
   await page.reload();await page.getByRole('heading',{name:'无权访问此页面',exact:true}).waitFor();expect(await page.locator('.journey-orders tbody tr').count()).toBe(0);
  }finally{await context.close();}
 });
 it('shows the signed ship-sample task before history, then retries only history without losing the task',async()=>{
  const f=h.fixture,actor=f.people.merchandiser!,style='TEST-SHIP-TASK-HISTORY-'+randomUUID();
  const mother=await h.runInScene(async()=>new DigitalProductionIdentityService(f.db,true).createOrder(f.root,DigitalOrderCreateSchema.parse({
   customerCode:'PD',productGroup:'男装',designStyleNo:style,orderDate:'2026-11-07',primaryMerchandiserId:actor.actorId,
   lines:[{formalPoNo:style,color:'黑',customerWarehouseArrivalDate:'2027-03-01',sizes:[{size:'M',quantity:10}]}]
  }),randomUUID()));
  const id=(await f.db.query<{task_id:string}>(
   "SELECT task_id FROM digital_production_task_access WHERE production_order_id=$1 AND task_kind='bulk_ship_sample'",
   [mother.productionOrderId])).rows[0]!.task_id;
  const endpoint='/api/digital-production/tasks/'+id;
  let release!:()=>void,taskReads=0,historyReads=0;
  const delay=new Promise<void>(resolve=>{release=resolve;});
  const tab=await h.open(actor.actorId,{},1165,1,{path:'/ui/digital-production?task='+id+'&taskView=read',beforeNavigate:async page=>{
   page.on('request',request=>{if(new URL(request.url()).pathname===endpoint&&request.method()==='GET')taskReads++;});
   await page.route(url=>url.pathname===endpoint+'/history',async route=>{
    historyReads++;
    if(historyReads===1){
     await delay;
     await route.fulfill({status:503,json:{error:{code:'UNAVAILABLE',message:'TEST 历史暂不可读'}}});
    }else await route.continue();
   });
  }});
  try{
   const {page}=tab,identity=page.locator('.digital-task-identity');
   await expect.poll(()=>historyReads).toBe(1);
   await identity.getByRole('heading',{name:style,exact:true}).waitFor();
   const history=page.locator('details').filter({has:page.getByText('历史记录与核实',{exact:true})}).last();
   await history.locator('summary').click();
   await history.getByRole('status').getByText('正在读取历史记录…',{exact:true}).waitFor();
   expect(taskReads).toBe(1);
   release();
   await history.getByRole('alert').getByText('TEST 历史暂不可读',{exact:true}).waitFor();
   expect(await identity.isVisible()).toBe(true);
   const reloaded=page.waitForResponse(response=>new URL(response.url()).pathname===endpoint+'/history'&&response.status()===200);
   await history.getByRole('button',{name:'重试历史记录',exact:true}).click();await reloaded;
   await history.getByRole('alert').waitFor({state:'detached'});
   expect(historyReads).toBe(2);expect(taskReads).toBe(1);
   expect(await identity.isVisible()).toBe(true);
  }finally{release();await tab.context.close();}
 });

});
