import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {beforeAll,afterAll,describe,it,expect,vi} from 'vitest';
import {supplychainSettingsBrowser} from '../acceptance/supplychain-settings-browser.js';
import {DigitalJourneyQuery} from '../../apps/api/src/production-platform/journey-query.js';
import {configureTimelineAdoption} from '../../apps/api/src/production-platform/fixed-timeline-mode.js';
import {JourneyFactRepository} from '../../apps/api/src/production-platform/journey-fact-repository.js';
import {FixedTimelineAdoptionRepository} from '../../apps/api/src/production-platform/fixed-timeline-adoptions.js';
import type {OrderJourney} from '@dx-rework/contracts/digital-production-journey';
import {testExecutionConfig} from '../../scripts/test-execution-config.mjs';

vi.setConfig({testTimeout:testExecutionConfig.correctnessTimeoutMs,hookTimeout:testExecutionConfig.correctnessTimeoutMs});
const url=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
(url?describe.sequential:describe.skip)('original authenticated App finite forecast field consumer',()=>{
 let h:Awaited<ReturnType<typeof supplychainSettingsBrowser>>;
 beforeAll(async()=>{h=await supplychainSettingsBrowser(url!,await mkdtemp(join(tmpdir(),'dx-bounded-forecast-app-')),{fullApp:true,orderTimeModel:true,orderTimeFlow:true});});
 afterAll(async()=>{if(h){await h.writeEvidence();await h.dispose();}});
 it('shows crossing-B PO bounds and the selected node own bounds, then removes them on a different node, at desktop and narrow widths',async()=>{
  const f=h.f,scene=await f.scene('2026-11-17T08:00:00.000Z');
  // Use the existing original two-PO native path. This display-only test
  // does not depend on another PR's admission helper or current-task repair.
  const ready=await f.runtime.run(scene,f.root,async()=>{configureTimelineAdoption(f.db,'fixed_v2');try{return await f.bulkReady('无',undefined,2);}finally{configureTimelineAdoption(f.db,'legacy');}}),orderId=ready.id;
  const resource={kind:'order' as const,id:orderId},repo=new FixedTimelineAdoptionRepository(f.db);
  const original=await f.runtime.run(scene,f.root,async()=>{await new JourneyFactRepository(f.db).buildOne(resource);return new DigitalJourneyQuery(f.db).read(f.root,orderId,undefined,true);}),plan=await repo.currentTargets(resource);
  const nodes=original.stages.flatMap(stage=>stage.nodes),selected=nodes.find(node=>node.key==='bulk_cutting'&&node.current&&node.fixedTargets?.length===2)!;
  const other=nodes.find(node=>node.instanceId!==selected?.instanceId&&node.current&&node.fixedTargets?.some(t=>!t.progress.businessCompleted)&&!['cancelled','inherited','completed'].includes(node.state))!;
  expect(selected).toBeDefined();expect(other).toBeDefined();
  // Explicit transport fixture: original authenticated HTTP identity/plan/task
  // stay intact. Only forecast fields adapt a nondegenerate bounded contract.
  // This UI consumer test does not claim a new forecast-engine or Root result.
  const endpoints={scopeL:'2026-11-17T09:00:00.123Z',scopeU:'2026-11-17T13:00:00.456Z',nodeL:'2026-11-17T08:30:00.123Z',nodeU:'2026-11-17T10:30:00.456Z',lower:'2026-11-17T14:00:00.123Z',ignoredUpper:'2099-01-01T00:00:00.000Z'};
  const adapt=(value:OrderJourney)=>{
   const copy=structuredClone(value);
   for(const [index,scope] of copy.fixedSchedule!.scopes.entries()){
    scope.completionEstimate=index?{kind:'lower_bound',earliest:endpoints.lower,latest:null}:{kind:'conditional',earliest:endpoints.scopeL,latest:endpoints.scopeU};
    scope.lagMinutes={minimum:-60,maximum:180};scope.state='unknown';scope.coverage=['TEST original bounded forecast condition'];
   }
   for(const node of copy.stages.flatMap(stage=>stage.nodes))if(node.instanceId===selected.instanceId||node.instanceId===other.instanceId){
    for(const target of node.fixedTargets??[]){target.progress.businessCompleted=false;target.progress.state='unknown';target.progress.estimateKind=node.instanceId===selected.instanceId?'conditional':'lower_bound';target.progress.availabilityBound=node.instanceId===selected.instanceId?{earliest:endpoints.nodeL,latest:endpoints.nodeU}:{earliest:endpoints.lower,latest:endpoints.ignoredUpper};}
   }
   return copy;
  };
  h.setCollectionScene(scene);
  for(const width of [1165,390]){
   const tab=await h.open(f.root.actorId,width,{},'/ui/digital-cockpit');
   try{
    await tab.page.route('**/api/digital-production/journeys/'+orderId+'*',async route=>{
     if(new URL(route.request().url()).pathname!=='/api/digital-production/journeys/'+orderId)return route.continue();
     const response=await route.fetch();expect(response.status()).toBe(200);const actual=await response.json() as OrderJourney;await route.fulfill({response,json:adapt(actual)});
    });
    await tab.page.goto(h.base+'/ui/digital-cockpit?selected='+orderId+'&expanded='+selected.stage+'&focus='+encodeURIComponent(selected.instanceId));
    const po=tab.page.locator('.journey-po-order-facts');await po.waitFor();
    const first=po.locator('[data-forecast-scope="'+original.fixedSchedule!.scopes[0]!.scopeRef+'"]');await expect.poll(()=>first.innerText()).toContain('17:00:00.123 至 2026-11-17 21:00:00.456');
    expect(await first.locator('..').innerText()).toContain('待核');expect(await first.innerText()).toContain('TEST original bounded forecast condition');
    const details=tab.page.locator('.cockpit-current-additional');if(!await details.evaluate((element:HTMLDetailsElement)=>element.open))await details.locator('summary').click();
    const current=tab.page.getByRole('region',{name:'当前节点资料'});await expect.poll(()=>current.innerText()).toContain('16:30:00.123 至 2026-11-17 18:30:00.456');
    expect(await current.innerText()).not.toContain('17:00:00.123 至');
    await tab.page.getByRole('button',{name:'本单全部节点',exact:true}).click();
    await tab.page.locator(`[id="journey-node-${other.instanceId}"]`).getByRole('button',{name:other.label,exact:true}).click();
    if(!await details.evaluate((element:HTMLDetailsElement)=>element.open))await details.locator('summary').click();
    await expect.poll(()=>current.innerText()).toContain('预计完成下界：2026-11-17 22:00:00.123');
    expect(await current.innerText()).toContain('上界待核');expect(await current.innerText()).not.toContain('2099');expect(await current.innerText()).not.toContain('16:30:00.123');
    const geometry=await current.locator('.cockpit-node-forecast').evaluateAll(rows=>rows.map(row=>{
     const box=row.getBoundingClientRect(),label=row.querySelector('dt')!.getBoundingClientRect(),value=row.querySelector('dd')!.getBoundingClientRect();
     return {labelInside:label.left>=box.left&&label.right<=box.right+.5,valueInside:value.left>=box.left&&value.right<=box.right+.5,noOverlap:value.top>=label.bottom-.5};
    }));
    expect(geometry.length).toBeGreaterThan(0);for(const row of geometry)expect(row).toEqual({labelInside:true,valueInside:true,noOverlap:true});
    await writeFile(join(h.evidence,'finite-ui-'+width+'.txt'),await tab.page.locator('body').innerText());await tab.page.screenshot({path:join(h.evidence,'finite-ui-'+width+'.png'),fullPage:true});
    expect(h.requests.filter(request=>request.session===tab.session&&request.method!=='GET'&&request.method!=='HEAD'&&request.path.startsWith('/api/digital-production/')&&request.path!=='/api/digital-production/notifications/claim?remaining=1')).toEqual([]);
   }catch(error){await writeFile(join(h.evidence,'finite-ui-failed-'+width+'.html'),await tab.page.content());throw error;}finally{await tab.context.close();}
  }
  expect(await repo.currentTargets(resource)).toEqual(plan);
  const after=await f.runtime.run(scene,f.root,()=>new DigitalJourneyQuery(f.db).read(f.root,orderId,undefined,true));
  expect(after.fixedSchedule).toEqual(original.fixedSchedule);expect(after.stages.flatMap(stage=>stage.nodes).map(node=>({id:node.instanceId,expected:node.expectedAt,actual:node.actualAt,deadline:node.nativeTaskDeadline}))).toEqual(nodes.map(node=>({id:node.instanceId,expected:node.expectedAt,actual:node.actualAt,deadline:node.nativeTaskDeadline})));expect(h.errors).toEqual([]);
 });
});
