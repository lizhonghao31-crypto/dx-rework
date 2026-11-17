import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {supplychainSettingsBrowser} from '../acceptance/supplychain-settings-browser.js';
import {randomUUID} from 'node:crypto';
import {beforeAll,afterAll,describe,it,expect,vi} from 'vitest';
import type {businessAnchorFixture} from '../helpers/business-anchor-fixture.js';
import {admittedFrameworkProductionFixture,prepareRewashSettings} from '../helpers/order-time-rewash-fixture.js';
import {FactoryFlowService} from '../../apps/api/src/production-platform/factory-flow-service.js';
import {ReceivingService} from '../../apps/api/src/receiving/receiving-service.js';
import {OrderClosureService} from '../../apps/api/src/production-platform/order-closure-service.js';
import {DigitalJourneyQuery} from '../../apps/api/src/production-platform/journey-query.js';
import {nodeStatus} from '../../apps/web/src/digital-journey-cockpit-model.js';
import {testExecutionConfig} from '../../scripts/test-execution-config.mjs';

vi.setConfig({testTimeout:testExecutionConfig.correctnessTimeoutMs,hookTimeout:testExecutionConfig.correctnessTimeoutMs});
const url=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
(url?describe.sequential:describe.skip)('original terminal quality projections preserve unfinished facts',()=>{
 let f:Awaited<ReturnType<typeof businessAnchorFixture>>,h:Awaited<ReturnType<typeof supplychainSettingsBrowser>>;
 beforeAll(async()=>{h=await supplychainSettingsBrowser(url!,await mkdtemp(join(tmpdir(),'dx-quality-terminal-app-')),{fullApp:true,orderTimeModel:true,orderTimeFlow:true});f=h.f;await prepareRewashSettings(f);});
 afterAll(async()=>{if(h){await h.writeEvidence();await h.dispose();}});
 it('shows the stopped receiving-QC instance after special closure with frozen four-hour delay and no invented completion',async()=>{
  const {scene,orderId,ready,lineId}=await admittedFrameworkProductionFixture(f);
  await f.runtime.run(scene,f.root,async()=>{
   const cut=(await f.db.query('SELECT cutting_order_id FROM cutting_orders WHERE sourcing_case_id=$1',[ready.caseId])).rows[0].cutting_order_id;
   const cutter={...f.people['cutting-worker']!,authorizationCapability:'cutting:records:create',authorizationCapabilities:['cutting:records:create']};
   await ready.cutting.record(cutter,cut,{pieceCount:1,actualCutCount:2,attachmentIds:[await f.image(cutter)]},randomUUID());
   const flow=new FactoryFlowService(f.db),state=await flow.read(f.root,orderId);
   await flow.dispatch(f.root,orderId,{expectedRevision:state.revision,supplierId:f.supplierId,note:'TEST actual dispatch before terminal quality'},randomUUID());
   const warehouse={...f.people.warehouse!,authorizationCapability:'receiving:create',authorizationCapabilities:['receiving:create']};
   await new ReceivingService(f.db).create(warehouse,{cuttingOrderId:cut,documentQuantity:2,actualQuantity:2,attachmentIds:[await f.image(warehouse)]},randomUUID());
  });
  await f.advance(scene,'2026-11-17T13:00:00.000Z');
  await f.runtime.run(scene,f.root,async()=>{
   const closure=new OrderClosureService(f.db),before=await closure.read(f.root,orderId);
   await closure.close(f.root,orderId,{expectedRevision:before.revision,reason:'TEST special closure of real unfinished warehouse QC'},randomUUID());
  });
  for(const now of ['2026-11-17T13:00:00.000Z','2026-11-18T13:00:00.000Z']){
   if(now.endsWith('18T13:00:00.000Z'))await f.advance(scene,now);
   const {detail,node}=await f.runtime.run(scene,f.root,async()=>{
    const detail=await new DigitalJourneyQuery(f.db).read(f.root,orderId,undefined,true),node=detail.stages.flatMap(stage=>stage.nodes).find(node=>node.key==='receiving_inspection')!;
    const work=detail.fixedSchedule!.scopes.find(scope=>scope.lineId===lineId)!.nodes.find(work=>work.id.startsWith('garment_inspection'))!;
    expect(work).toMatchObject({businessCompleted:false,ownSla:{state:'terminated',overdueMinutes:{minimum:240,maximum:240}}});
    expect(nodeStatus(node),JSON.stringify({node,work})).toContain('计时已终止');expect(node.actualAt).toBeNull();expect(node.state).not.toBe('completed');
    return {detail,node};
   });
    // Original HTTP resource hooks acquire the same scene lock themselves.
    // Do not hold it around a browser request or block its authenticated read.
    h.setCollectionScene(scene);
    const tab=await h.open(f.root.actorId,1165,{},'/ui/digital-cockpit?search='+encodeURIComponent(detail.designStyleNo));
    try{
     const row=tab.page.locator(`[data-order-id="${detail.id}"]`);await row.waitFor();
     expect(await row.getByText('已特殊结案',{exact:true}).count()).toBeGreaterThan(0);expect(await row.locator('.cockpit-home-task-heading').count()).toBe(0);
     await tab.page.goto(h.base+'/ui/digital-cockpit?selected='+detail.id+'&expanded='+node.stage+'&focus='+encodeURIComponent(node.instanceId));
     await tab.page.getByRole('button',{name:'本单全部节点',exact:true}).click();
     await tab.page.getByLabel('节点阶段筛选',{exact:true}).selectOption(node.stage);
     const summary=tab.page.locator('.cockpit-node-summary').locator(`[id="journey-node-${node.instanceId}"]`);await summary.waitFor();
     expect(await summary.innerText()).toContain('计时已终止');expect(await summary.innerText()).not.toContain('进行中');
     expect(h.errors).toEqual([]);
    }catch(error){await writeFile(join(h.evidence,'terminal-detail.html'),await tab.page.content());await writeFile(join(h.evidence,'terminal-detail.txt'),await tab.page.locator('body').innerText());throw error;}finally{await tab.context.close();}
  }
 });
});
