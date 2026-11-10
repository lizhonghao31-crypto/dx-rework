import {beforeAll,afterAll,describe,it,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {supplychainSettingsBrowser} from '../acceptance/supplychain-settings-browser.js';
import {configureTimelineAdoption} from '../../apps/api/src/production-platform/fixed-timeline-mode.js';
import {SlaSettingsSetsService} from '../../apps/api/src/production-platform/sla-settings-sets.js';
import {JourneyFactRepository} from '../../apps/api/src/production-platform/journey-fact-repository.js';
import {SETTINGS_PLANNING_KEYS,type SettingsSetDraft} from '@dx-rework/contracts/sla-settings-sets';
import type {OrderJourney} from '@dx-rework/contracts/digital-production-journey';
import {cockpitDuration} from '../../apps/web/src/cockpit-fixed-schedule.js';
import {testExecutionConfig} from '../../scripts/test-execution-config.mjs';
vi.setConfig({testTimeout:testExecutionConfig.correctnessTimeoutMs,hookTimeout:testExecutionConfig.correctnessTimeoutMs});
const url=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
(url?describe.sequential:describe.skip)('supply-chain six-PR integrated original App and native adopted facts',()=>{
 let h:Awaited<ReturnType<typeof supplychainSettingsBrowser>>,id:string;
 beforeAll(async()=>{h=await supplychainSettingsBrowser(url!,join(process.env.M01_SETTINGS_NATIVE_EVIDENCE??tmpdir(),'supplychain-board-'+randomUUID()),{fullApp:true});
  const service=new SlaSettingsSetsService(h.db,'TEST integrated real paired adoption '.repeat(3)),state=await service.read(h.f.root),draft:SettingsSetDraft={...state.basis,values:structuredClone(state.current),reason:'TEST explicit planning for native integrated UI, not onsite defaults'};
  for(const key of SETTINGS_PLANNING_KEYS)draft.values.planning[key]={minutes:draft.values.unified[key as keyof typeof draft.values.unified]?.kind==='included'?0:60,calendar:'continuous'};
  const saved=await service.save(h.f.root,draft,randomUUID()),next={...draft,...saved.basis},preview=await service.preview(h.f.root,next);await service.publish(h.f.root,{...next,previewToken:preview.token},randomUUID());
  const scene=await h.f.scene('2026-11-11T08:00:00.000Z');configureTimelineAdoption(h.db,'fixed_v2');
  try{const ready=await h.f.runtime.run(scene,h.f.root,()=>h.f.bulkReady('印绣花',undefined,2,h.f.sourcing,{developmentReturnDate:'2027-02-01',craftSteps:[{craftKind:'embroidery',sequence:1},{craftKind:'printing',sequence:2}]}));id=ready.id;await h.f.runtime.run(scene,h.f.root,async()=>{await new JourneyFactRepository(h.db).buildOne({kind:'order',id});});}finally{configureTimelineAdoption(h.db,'legacy');}
 });
 afterAll(async()=>{if(h){await h.writeEvidence();await h.dispose();}});
 it('keeps the five permitted child entries under an expansion-only parent and no duplicate reporting navigation',async()=>{
  const {page,context}=await h.open();try{const group=page.locator('aside .supply-chain-navigation'),summary=group.locator(':scope>summary');await summary.waitFor();expect(await summary.locator('a').count()).toBe(0);const original=page.url();await summary.click();expect(page.url()).toBe(original);if(!await group.getAttribute('open'))await summary.click();const names=await group.locator('a strong').allTextContents();expect(names).toEqual(['生产管理座舱','实时生产看板','交付点阵图','生产数据沙盘','生产管理设置']);expect(await page.locator('aside').getByRole('link',{name:/生产数据填报/}).count()).toBe(0);
  }finally{await context.close();}
 });
 it('reads complete real fixed targets and two ordered craft scopes after new adoption is disabled, and renders matching dates and spans',async()=>{
  const {page,context}=await h.open();try{await page.goto(h.base+'/ui/digital-cockpit?selected='+id);await page.locator('[data-view="order"][aria-busy="false"]').waitFor();const dto=await page.evaluate(async selected=>{const r=await fetch('/api/digital-production/journeys/'+selected);if(!r.ok)throw Error('Native detail refused '+r.status);return r.json();},id) as OrderJourney;
   expect(dto.fixedSchedule?.scopes).toHaveLength(2);expect(dto.fixedSchedule?.observationMode).toBe('fixed');expect(dto.fixedSchedule!.scopes.flatMap(scope=>scope.nodes.filter(node=>!node.goalDelta.targetAt).map(node=>({scope:scope.scopeRef,id:node.id,coverage:node.coverage})))).toEqual([]);
   for(const scope of dto.fixedSchedule!.scopes){expect(scope.nodes.filter(n=>n.id==='bulk_embroidery'||n.id==='bulk_printing')).toHaveLength(2);expect(scope.nodes.some(n=>n.id==='bulk_print_embroidery')).toBe(false);}
   const nativeTask=dto.stages.flatMap(stage=>stage.nodes).find(node=>node.nativeTaskDeadline&&node.records.some(record=>record.domain==='task'&&record.id===node.instanceId));expect(nativeTask).toBeDefined();const task=await page.evaluate(async taskId=>{const r=await fetch('/api/digital-production/tasks/'+taskId);if(!r.ok)throw Error('Original task read refused '+r.status);return r.json();},nativeTask!.instanceId);expect(task.dueAt).toBe(nativeTask!.nativeTaskDeadline!.at);expect(nativeTask!.fixedTargets?.length).toBeGreaterThan(0);
   expect(dto.visualProgress?.expected.at).not.toBeNull();expect(await page.getByLabel('订单总用时').innerText()).toContain(cockpitDuration(dto.fixedSchedule!.durationSummary.planSpanMinutes));expect(await page.getByLabel('订单总用时').innerText()).toContain('最终实际历时：—');
   for(const width of [1165,1440]){await page.setViewportSize({width,height:1003});const stages=page.locator('.cockpit-stage');expect(await stages.count()).toBe(7);expect(await stages.locator('.cockpit-target-difference').count()).toBe(7);const firstRow=page.locator('.journey-node-table tbody>tr').first();expect((await firstRow.boundingBox())!.height).toBeLessThan(160);const poLabel=firstRow.locator('.cockpit-fixed-target-date>small').first();expect(await poLabel.getAttribute('title')).toContain(dto.lines[0]!.po!);expect(await poLabel.evaluate(label=>getComputedStyle(label).textOverflow)).toBe('ellipsis');expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);await page.screenshot({path:join(h.evidence,'native-fixed-detail-'+width+'.png'),fullPage:true});}
   expect(h.errors).toEqual([]);
  }finally{await context.close();}
 });
 it('preserves all seven original whole-range KPI values and separate plan filters on the actual current query',async()=>{
  const {page,context}=await h.open();try{await page.goto(h.base+'/ui/digital-cockpit');await page.locator('[data-view="overview"][aria-busy="false"]').waitFor();const query=await page.evaluate(async()=> (await fetch('/api/digital-production/journeys?scope=production')).json());expect(query.total).toBe(1);for(const[label,key]of [['订单总数','all'],['进行中','active'],['未启动','notStarted'],['临期','dueSoon'],['逾期','overdue'],['时效待补充','timingMissing'],['整单已完成','completed']] as const){expect(await page.locator('.journey-kpis').getByRole('button',{name:new RegExp(label)}).locator('strong').innerText()).toBe(String(query.summary[key]));}
   await page.getByRole('button',{name:'更多筛选',exact:true}).click();await page.getByLabel('计划与交期',{exact:true}).selectOption('unknown');await page.locator('[data-view="overview"][aria-busy="false"]').waitFor();expect(new URL(page.url()).searchParams.get('progress')).toBe('unknown');
  }finally{await context.close();}
 });
});
