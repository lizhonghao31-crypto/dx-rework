import {randomUUID} from 'node:crypto';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {beforeAll,afterAll,describe,it,expect,vi} from 'vitest';
import {supplychainSettingsBrowser} from '../acceptance/supplychain-settings-browser.js';
import {admittedProductionFixture} from '../helpers/order-time-rewash-fixture.js';
import {r5OneHourConfiguration} from '../helpers/r5-order-time-fixture.js';
import {productionReadinessFixture} from '../helpers/production-readiness-fixture.js';
import {OrderTimeSettingsService} from '../../apps/api/src/production-platform/order-time-settings-service.js';
import {ProductionInstructionService} from '../../apps/api/src/production-platform/production-instruction-service.js';
import {SpecialCraftLibraryService} from '../../apps/api/src/production-platform/special-craft-library.js';
import {prepareTimeFrameworkConfiguration} from '@dx-rework/contracts/order-time-settings';
import {OrderTimeApplySchema} from '@dx-rework/contracts/order-time-requests';
import {testExecutionConfig} from '../../scripts/test-execution-config.mjs';

vi.setConfig({testTimeout:testExecutionConfig.correctnessTimeoutMs,hookTimeout:testExecutionConfig.correctnessTimeoutMs});
const url=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
(url?describe.sequential:describe.skip)('linked arrangements retain current native applicability and atomicity',()=>{
 let h:Awaited<ReturnType<typeof supplychainSettingsBrowser>>;
 beforeAll(async()=>{h=await supplychainSettingsBrowser(url!,await mkdtemp(join(tmpdir(),'dx-linked-applicability-app-')),{fullApp:true,orderTimeModel:true,orderTimeFlow:true});});
 afterAll(async()=>{if(h){await h.writeEvidence();await h.dispose();}});
 it.each([false,true])('publishes independent default36h and adjusted24h requests, retains shared updates and rolls back a real linked failure, framework=%s',async framework=>{
  const f=h.f,settings=new OrderTimeSettingsService(f.db,true,framework),configuration=await settings.read(f.root),values=r5OneHourConfiguration();
  await settings.save(f.root,{expectedVersion:configuration.version,values:framework?prepareTimeFrameworkConfiguration(values):values},randomUUID());
  const library=new SpecialCraftLibraryService(f.db),definition={name:'TEST legitimate future C '+randomUUID(),enabled:true,development:{minutes:2160,calendar:'continuous' as const,reminder:{enabled:true,percent:70}},bulk:{minutes:2160,calendar:'continuous' as const,reminder:{enabled:true,percent:70}}};
  const special=await library.save(f.root,{id:null,expectedVersion:0,definition},randomUUID()),unused=await library.save(f.root,{id:null,expectedVersion:0,definition:{...definition,name:'TEST library-only C '+randomUUID()}},randomUUID()),parameterKey='bulk_special_'+special.id.replaceAll('-','');
  const prepare=async(label:string)=>{
   const fixture=await admittedProductionFixture(f,framework);
   return f.runtime.run(fixture.scene,f.root,async()=>{
    const instructions=new ProductionInstructionService(f.db,true),before=await instructions.read(f.root,fixture.orderId),sourceBefore=(await fixture.repo.current({kind:'source',id:fixture.sourceId}))!,planBefore=(await fixture.repo.current(fixture.resource()))!;
    const draft=await instructions.save(f.root,fixture.orderId,{expectedVersion:before.version,orderVersion:before.currentOrderVersion,sourceRound:before.sourceRound,document:{...before.document,secondaryCraft:'特殊工艺',craftSteps:[{craftKind:'special',sequence:1,specialCraft:special}]}},randomUUID());
    const readiness=await productionReadinessFixture(f.db,f.root,fixture.orderId,f.people['pattern-room-worker']!.actorId,f.people.warehouse!);
    const operation={kind:'instruction_publish' as const,orderId:fixture.orderId,input:{expectedVersion:draft.version,orderVersion:draft.currentOrderVersion,expectedReadinessRevision:readiness.revision}},base=await fixture.requests.check(f.root,operation),work=base.rows.find(row=>row.parameterKey===parameterKey)!;
    expect(work).toMatchObject({begun:false,rule:{kind:'work',minutes:2160,calendar:'continuous'}});expect(base.feasibility).not.toBe('unknown');
    const pending=await fixture.requests.submit(f.root,{operation,fingerprint:base.fingerprint,reason:'TEST independent '+label+' future C publication'},randomUUID());
    const originalAdoptions=(await f.db.query('SELECT adoption_id,identity_hash,input_snapshot FROM digital_timeline_adoptions WHERE production_order_id=$1 OR source_id=$2 ORDER BY adoption_id',[fixture.orderId,fixture.sourceId])).rows;
    return {...fixture,instructions,before,draft,operation,base,work,pending,sourceBefore,planBefore,originalAdoptions};
   });
  };
  // Separate legitimate drafts/requests with the same standards and native
  // preparation. A successful request is never reset or retried as pending.
  const control=await prepare('default36'),controlRead=await f.runtime.run(control.scene,f.root,()=>control.requests.read(f.root,control.pending.requestId));
  const controlResult=await f.runtime.run(control.scene,f.root,()=>control.requests.apply(f.root,control.pending.requestId,{expectedVersion:controlRead.version,fingerprint:controlRead.check.fingerprint,overrides:{},acceptLate:true},randomUUID()));
  expect(controlResult.state).toBe('applied');
  await f.runtime.run(control.scene,f.root,async()=>{
   expect((await control.instructions.read(f.root,control.orderId)).publishedVersion).toBe(control.draft.version);
   const plan=(await control.repo.current(control.resource()))!;expect(plan.input.work.filter(work=>work.parameterKey===parameterKey)).toHaveLength(1);
   expect(plan.input.plan.overrides[parameterKey]).toBeUndefined();expect((await control.repo.current({kind:'source',id:control.sourceId}))!.id).toBe(control.sourceBefore.id);
  });
  const controlPlanId=(await control.repo.current(control.resource()))!.id;
  const target=await prepare('adjust24'),overrides={[parameterKey]:{...target.work.rule!,kind:'work' as const,minutes:1440}},preview=await f.runtime.run(target.scene,f.root,()=>target.requests.read(f.root,target.pending.requestId,overrides));
  expect(preview.check.rows.find(row=>row.id===target.work.id)).toMatchObject({begun:false,rule:{minutes:1440,calendar:'continuous'}});
  expect(preview.check.feasibility).toBe('sufficient');
  let body=OrderTimeApplySchema.parse({expectedVersion:preview.version,fingerprint:preview.check.fingerprint,overrides,acceptLate:true}),key=randomUUID();
  if(framework){
   h.setCollectionScene(target.scene);const tab=await h.open(f.root.actorId,1165,{},'/ui/digital-production?timeRequest='+target.pending.requestId);
   try{
    const page=tab.page;await page.getByRole('heading',{name:'本单时效调整',exact:false}).waitFor();await page.getByRole('navigation',{name:'本单时效阶段'}).getByRole('button',{name:'裁后工艺与发厂',exact:true}).click();
    const input=page.getByLabel(target.work.label+'本次用时',{exact:true});expect(await input.inputValue()).toBe('36');
    const changed=page.waitForResponse(response=>response.url().endsWith('/requests/'+target.pending.requestId+'/preview')&&response.request().postDataJSON()?.overrides?.[parameterKey]?.minutes===1440);
    await input.fill('24');await input.press('Tab');expect((await changed).status()).toBe(200);
    const submitted=page.waitForResponse(response=>response.url().endsWith('/requests/'+target.pending.requestId+'/apply')&&response.request().method()==='POST');
    // This fixture has a genuine sufficient horizon. The original page only
    // asks for a late-risk confirmation when the current arrangement is late.
    await page.getByRole('button',{name:'提交',exact:true}).click();
    const response=await submitted;body=OrderTimeApplySchema.parse(response.request().postDataJSON());key=h.requests.find(call=>call.session===tab.session&&call.path.endsWith('/requests/'+target.pending.requestId+'/apply'))!.key!;
    expect(response.status(),await response.text()).toBe(200);expect((await response.json()).state).toBe('applied');await page.screenshot({path:join(h.evidence,'adjust24-original-request.png'),fullPage:true});
   }catch(error){await writeFile(join(h.evidence,'adjust24-original-request.html'),await tab.page.content());throw error;}finally{await tab.context.close();}
  }else await f.runtime.run(target.scene,f.root,()=>target.requests.apply(f.root,target.pending.requestId,body,key));
  await f.runtime.run(target.scene,f.root,async()=>{
   const source={kind:'source' as const,id:target.sourceId},applied=(await target.repo.current(target.resource()))!;
   expect((await target.instructions.read(f.root,target.orderId)).publishedVersion).toBe(target.draft.version);
   expect(applied.input.plan.overrides[parameterKey]).toMatchObject({kind:'work',minutes:1440,calendar:'continuous'});expect(applied.input.work.filter(work=>work.parameterKey===parameterKey)).toHaveLength(1);
   expect((await target.repo.current(source))!.id).toBe(target.sourceBefore.id);
   expect((await f.db.query('SELECT adoption_id,identity_hash,input_snapshot FROM digital_timeline_adoptions WHERE production_order_id=$1 OR source_id=$2 ORDER BY adoption_id',[target.orderId,target.sourceId])).rows).toEqual(target.originalAdoptions);
   const snapshot=async()=>({main:await target.repo.current(target.resource()),source:await target.repo.current(source),requests:(await f.db.query('SELECT request_id,version,state,applied_plan_id FROM digital_order_time_requests WHERE production_order_id=$1 OR source_id=$2 ORDER BY request_id',[target.orderId,target.sourceId])).rows,plans:(await f.db.query('SELECT plan_version_id,revision,identity_hash FROM digital_order_time_plan_versions WHERE production_order_id=$1 OR source_id=$2 ORDER BY plan_version_id',[target.orderId,target.sourceId])).rows,audit:(await f.db.query('SELECT id,action,md5(after_state::text) AS after_hash FROM audit_events WHERE entity_id=$1 OR entity_id=$2 ORDER BY id',[target.orderId,target.sourceId])).rows,commands:(await f.db.query("SELECT command,key,payload_hash FROM digital_production_commands WHERE actor_id=$1 AND command LIKE 'order-time:%' ORDER BY command,key",[f.root.actorId])).rows});
   const beforeReplay=await snapshot();expect((await target.requests.apply(f.root,target.pending.requestId,body,key)).state).toBe('applied');expect(await snapshot()).toEqual(beforeReplay);
   await expect(target.requests.apply(f.root,target.pending.requestId,{...body,overrides:{}},key)).rejects.toThrow('原操作标识不能用于其他内容');expect(await snapshot()).toEqual(beforeReplay);
   const ordinary={kind:'arrangement' as const,resource:target.resource()};
   await expect(target.requests.check(f.root,ordinary,{['bulk_special_'+unused.id.replaceAll('-','')]:overrides[parameterKey]!})).rejects.toThrow('不能修改本单不适用的节点');
   await expect(target.requests.check(f.root,ordinary,{['development_special_'+special.id.replaceAll('-','')]:overrides[parameterKey]!})).rejects.toThrow('不能修改本单不适用的节点');
   const current=await target.requests.check(f.root,ordinary),shared=current.rows.find(row=>row.parameterKey==='warehouse_dispatch')!,sharedChanges={warehouse_dispatch:{...shared.rule!,kind:'work' as const,minutes:120}},sharedPreview=await target.requests.check(f.root,ordinary,sharedChanges),raceBody={resource:target.resource(),fingerprint:sharedPreview.fingerprint,overrides:sharedChanges,acceptLate:true};
   const raced=await Promise.allSettled([target.requests.arrange(f.root,raceBody,randomUUID()),target.requests.arrange(f.root,raceBody,randomUUID())]);expect(raced.filter(row=>row.status==='fulfilled')).toHaveLength(1);expect(raced.filter(row=>row.status==='rejected')).toHaveLength(1);
   expect((await target.repo.current(source))!.input.plan.overrides.warehouse_dispatch).toMatchObject({minutes:120});expect((await target.repo.current(source))!.input.plan.overrides[parameterKey]).toBeUndefined();
   const begun=(await target.requests.check(f.root,ordinary)).rows.find(row=>row.begun&&row.rule?.kind==='work');expect(begun).toBeDefined();
   await expect(target.requests.check(f.root,ordinary,{[begun!.parameterKey]:{...begun!.rule!,kind:'work',minutes:begun!.rule!.minutes!+60}})).rejects.toThrow(/已开始/);
   const baseline=await target.requests.check(f.root,ordinary),pending=await target.requests.submit(f.root,{operation:ordinary,fingerprint:baseline.fingerprint,reason:'TEST linked apply rollback after real main append'},randomUUID()),changes={warehouse_dispatch:{...sharedChanges.warehouse_dispatch,minutes:180}},check=await target.requests.read(f.root,pending.requestId,changes),faultBody={expectedVersion:check.version,fingerprint:check.check.fingerprint,overrides:changes,acceptLate:true},faultKey=randomUUID(),beforeFault=await snapshot();
   const trigger='test_linked_apply_fault_'+String(framework),revision=(await target.repo.current(target.resource()))!.revision;
   await f.db.query(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.source_id::text=TG_ARGV[0] THEN
     IF (SELECT coalesce(max(revision),0) FROM digital_order_time_plan_versions WHERE production_order_id::text=TG_ARGV[1])<=TG_ARGV[2]::int THEN RAISE EXCEPTION 'TEST fault did not reach main append'; END IF;
     RAISE EXCEPTION 'TEST controlled linked append after main';
    END IF; RETURN NEW; END $$`);
   await f.db.query(`CREATE TRIGGER ${trigger} BEFORE INSERT ON digital_order_time_plan_versions FOR EACH ROW EXECUTE FUNCTION ${trigger}('${target.sourceId}','${target.orderId}','${revision}')`);
   try{await expect(target.requests.apply(f.root,pending.requestId,faultBody,faultKey)).rejects.toThrow('TEST controlled linked append after main');expect(await snapshot()).toEqual(beforeFault);}
   finally{await f.db.query(`DROP TRIGGER ${trigger} ON digital_order_time_plan_versions`);await f.db.query(`DROP FUNCTION ${trigger}()`);}
   expect((await target.requests.apply(f.root,pending.requestId,faultBody,faultKey)).state).toBe('applied');const recovered=await snapshot();await target.requests.apply(f.root,pending.requestId,faultBody,faultKey);expect(await snapshot()).toEqual(recovered);
   await writeFile(join(h.evidence,'linked-pair-and-rollback-'+framework+'.json'),JSON.stringify({control:{requestId:control.pending.requestId,instructionVersion:control.draft.version,source:control.sourceId,order:control.orderId},adjusted:{requestId:target.pending.requestId,instructionVersion:target.draft.version,source:target.sourceId,order:target.orderId,body,mainBefore:target.planBefore.id,mainAfter:applied.id},rollbackVerified:true,replayedWithoutExtraWrites:true},null,2));
  });
  await f.runtime.run(control.scene,f.root,async()=>{
   expect((await control.repo.current(control.resource()))!.id).toBe(controlPlanId);
   expect((await control.repo.current({kind:'source',id:control.sourceId}))!.id).toBe(control.sourceBefore.id);
  });
 });
});
