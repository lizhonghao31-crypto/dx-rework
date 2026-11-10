import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,describe,it,expect,vi} from 'vitest';
import {businessAnchorFixture} from '../helpers/business-anchor-fixture.js';
import {testExecutionConfig} from '../../scripts/test-execution-config.mjs';
import {SlaSettingsSetsService} from '../../apps/api/src/production-platform/sla-settings-sets.js';
import {SlaConfigurationRepository} from '../../apps/api/src/production-platform/sla-configuration-repository.js';
import {DigitalProductionTaskService} from '../../apps/api/src/production-platform/task-service.js';
import {DevelopmentTechnicalSettingsService} from '../../apps/api/src/production-platform/development-technical-settings.js';
import {SeriesPlanService} from '../../apps/api/src/production-platform/series-plan-service.js';
import type {SettingsSetRead,SettingsSetDraft} from '@dx-rework/contracts/sla-settings-sets';
vi.setConfig({testTimeout:testExecutionConfig.correctnessTimeoutMs,hookTimeout:testExecutionConfig.correctnessTimeoutMs});
const url=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
(url?describe.sequential:describe.skip)('supply-chain paired settings on original low-privilege PostgreSQL',()=>{
 let f:Awaited<ReturnType<typeof businessAnchorFixture>>,sets:SlaSettingsSetsService;
 const read=()=>sets.read(f.root);
 const input=(state:SettingsSetRead,reason='TEST explicit paired standards draft'):SettingsSetDraft=>({...state.basis,values:structuredClone(state.draft?.values??state.current),reason});
 const changed=async()=>{const draft=input(await read());draft.values.unified.bulk_cutting={kind:'duration',minutes:(draft.values.unified.bulk_cutting as {minutes:number}).minutes+60};draft.values.development.normalDays++;return draft;};
 const savePreview=async(draft:SettingsSetDraft)=>{const saved=await sets.save(f.root,draft,randomUUID()),next={...draft,...saved.basis},preview=await sets.preview(f.root,next);return {saved,next,preview};};
 const counts=async()=>Object.fromEntries(await Promise.all(['digital_sla_configurations','digital_development_cycle_standards','digital_timeline_standard_versions','digital_sla_settings_drafts','digital_sla_order_snapshots','digital_sla_plans'].map(async name=>[name,Number((await f.db.query(`SELECT count(*) AS count FROM ${name}`)).rows[0].count)])));
 beforeAll(async()=>{f=await businessAnchorFixture(url!);sets=new SlaSettingsSetsService(f.db,'TEST settings pair only '.repeat(5));});
 afterAll(async()=>{await f?.dispose();});
 it('opens read-only without initializing a pair or fabricating historical pairing',async()=>{const before=await counts(),state=await read();expect(state.basis.developmentVersion).toBeGreaterThan(0);expect(await counts()).toEqual(before);const history=await sets.history(f.root);expect(history.items.every(row=>row.setId!==null||row.partial&&row.developmentVersion===null)).toBe(true);});
 it('atomically saves both own drafts and keeps the original key receipt without consuming another browser draft',async()=>{
  const draft={...await changed(),reason:''},key=randomUUID(),before=await counts(),saved=await sets.save(f.root,draft,key);expect(saved.basis.unifiedDraftRevision).toBe(draft.unifiedDraftRevision+1);expect(saved.basis.developmentDraftRevision).toBe(draft.developmentDraftRevision+1);expect(saved.draft?.values).toEqual(draft.values);
  const newer=input(saved,'TEST newer browser draft');newer.values.development.normalDays++;const current=await sets.save(f.root,newer,randomUUID());expect(await sets.save(f.root,draft,key)).toEqual(saved);expect((await read()).basis).toEqual(current.basis);
  const after=await counts();expect(after.digital_sla_configurations).toBe(before.digital_sla_configurations);expect(after.digital_development_cycle_standards).toBe(before.digital_development_cycle_standards);
 });
 it('publishes one immutable pair, references unchanged sides, and replays the same set after a newer draft',async()=>{
  const {next,preview}=await savePreview(await changed()),key=randomUUID(),result=await sets.publish(f.root,{...next,previewToken:preview.token},key);expect(result.existingOrdersChanged).toBe(0);expect(result.set.unifiedVersion).toBe(next.unifiedVersion+1);expect(result.set.developmentVersion).toBe(next.developmentVersion+1);
  const current=await read(),onlyPlanning=input(current,'TEST planning only is not a new responsibility SLA');onlyPlanning.values.planning.factory_production_work={minutes:600,calendar:'beijing_sunday_excluded'};
  const plan=await savePreview(onlyPlanning),second=await sets.publish(f.root,{...plan.next,previewToken:plan.preview.token},randomUUID());expect(second.set.unifiedVersion).toBe(current.basis.unifiedVersion);expect(second.set.developmentVersion).toBe(current.basis.developmentVersion);
  await sets.save(f.root,input(await read(),'TEST later draft survives old publish retry'),randomUUID());const head=(await read()).basis;
  expect(await sets.publish(f.root,{...next,previewToken:preview.token},key)).toEqual(result);expect((await read()).basis).toEqual(head);
  await expect(f.db.query('UPDATE digital_timeline_standard_versions SET planning_json=\'{}\' WHERE standard_id=$1',[result.set.setId])).rejects.toBeTruthy();
 });
 it('rolls back both publication sides and draft receipts when the second original insert fails',async()=>{
  const {next,preview}=await savePreview(await changed()),before=await counts();
  await f.db.query("CREATE FUNCTION test_reject_paired_development() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'TEST controlled second-side storage failure'; END$$");
  await f.db.query('CREATE TRIGGER test_reject_paired_development BEFORE INSERT ON digital_development_cycle_standards FOR EACH ROW EXECUTE FUNCTION test_reject_paired_development()');
  try{await expect(sets.publish(f.root,{...next,previewToken:preview.token},randomUUID())).rejects.toThrow('TEST controlled second-side');expect(await counts()).toEqual(before);expect((await read()).draft?.values).toEqual(next.values);}
  finally{await f.db.query('DROP TRIGGER test_reject_paired_development ON digital_development_cycle_standards');await f.db.query('DROP FUNCTION test_reject_paired_development()');}
 });
 it('rejects either stale standard or stale personal revision before any write and preserves the saved values',async()=>{
  const state=await read(),draft=input(state),saved=await sets.save(f.root,draft,randomUUID()),before=await counts();
  await expect(sets.save(f.root,draft,randomUUID())).rejects.toMatchObject({statusCode:409});expect(await counts()).toEqual(before);
  await expect(sets.preview(f.root,{...draft,...saved.basis,developmentVersion:saved.basis.developmentVersion-1})).rejects.toMatchObject({statusCode:409});expect((await read()).draft?.values).toEqual(saved.draft?.values);
 });
 it('restores an evidenced pair to drafts only and a true legacy version only to its saved side',async()=>{
  const history=await sets.history(f.root),pair=history.items.find(row=>row.setId)!;expect(pair).toBeDefined();
  const before=await counts(),state=await read(),restored=await sets.restore(f.root,{...state.basis,setId:pair.setId,unifiedSourceVersion:null},randomUUID());expect(restored.draft?.partialRestore).toBe(false);expect((await counts()).digital_timeline_standard_versions).toBe(before.digital_timeline_standard_versions);
  const source=await sets.historyValues(f.root,{setId:pair.setId,unifiedSourceVersion:null});expect(restored.draft?.values).toEqual(source.values);
  const client=await f.db.connect();let version:number;try{await client.query('BEGIN');const repo=new SlaConfigurationRepository(client),current=(await repo.current())!,values=structuredClone(current.values);values.bulk_cutting={kind:'duration',minutes:(values.bulk_cutting as {minutes:number}).minutes+120};version=(await repo.publish({expectedVersion:current.version,values,actorId:f.root.actorId,reason:'TEST genuine legacy single-side record',requestKey:randomUUID()})).version;await client.query('COMMIT');}finally{await client.query('ROLLBACK');client.release();}
  const latest=await read(),draft=input(latest,'TEST retain independently edited development');draft.values.development.normalDays+=2;const saved=await sets.save(f.root,draft,randomUUID()),legacy=await sets.restore(f.root,{...saved.basis,setId:null,unifiedSourceVersion:version!},randomUUID());
  expect(legacy.draft?.partialRestore).toBe(true);expect(legacy.draft?.values.development).toEqual(draft.values.development);expect(legacy.draft?.values.planning).toEqual(draft.values.planning);expect((await sets.history(f.root)).items.find(row=>!row.setId&&row.unifiedVersion===version)?.developmentVersion).toBeNull();
 });
 it('keeps supported old one-side publishers paired with the actual current other side',async()=>{
  const state=await read(),tasks=new DigitalProductionTaskService(f.db,'TEST old publication '.repeat(4)),single={expectedVersion:state.basis.unifiedVersion,values:structuredClone(state.current.unified),reason:'TEST old client publishes genuine new unified standard'};single.values.bulk_cutting={kind:'duration',minutes:(single.values.bulk_cutting as {minutes:number}).minutes+30};
  const preview=await tasks.previewSlaSettings(f.root,single),result=await tasks.publishSlaSettings(f.root,{...single,previewToken:preview.token},randomUUID()),after=await read();expect(after.set?.unifiedVersion).toBe(result.version);expect(after.set?.developmentVersion).toBe(state.basis.developmentVersion);
  const development=new DevelopmentTechnicalSettingsService(f.db,true,'TEST old development '.repeat(4)),current=await development.read(f.root),draft={expectedVersion:current.version,values:{...current.values,normalDays:current.values.normalDays+1},reason:'TEST old development client publishes new real pair'},next=await development.preview(f.root,draft);
  await development.publish(f.root,{...draft,previewToken:next.token},randomUUID());const final=await read();expect(final.set?.unifiedVersion).toBe(result.version);expect(final.set?.developmentVersion).toBe(current.version+1);expect(final.set?.planning).toEqual(after.set?.planning);
 });
 it('binds both current standards to supported old previews and refuses counterpart changes in either direction',async()=>{
  const tasks=new DigitalProductionTaskService(f.db,'TEST pair conflict unified '.repeat(4)),development=new DevelopmentTechnicalSettingsService(f.db,true,'TEST pair conflict development '.repeat(4));
  const unified=await tasks.slaSettings(f.root),u={expectedVersion:unified.version,values:structuredClone(unified.values),reason:'TEST original one-side preview binds the real other side'};u.values.bulk_cutting={kind:'duration',minutes:(u.values.bulk_cutting as {minutes:number}).minutes+60};const up=await tasks.previewSlaSettings(f.root,u);
  const current=await development.read(f.root),d={expectedVersion:current.version,values:{...current.values,normalDays:current.values.normalDays+1},reason:'TEST another window changes development'},dp=await development.preview(f.root,d);await development.publish(f.root,{...d,previewToken:dp.token},randomUUID());
  await expect(tasks.publishSlaSettings(f.root,{...u,previewToken:up.token},randomUUID())).rejects.toMatchObject({statusCode:409});expect((await tasks.slaSettings(f.root)).version).toBe(unified.version);
  const next=await development.read(f.root),dd={expectedVersion:next.version,values:{...next.values,normalDays:next.values.normalDays+1},reason:'TEST other-side development preview'},preview=await development.preview(f.root,dd),fresh=await tasks.previewSlaSettings(f.root,u);await tasks.publishSlaSettings(f.root,{...u,previewToken:fresh.token},randomUUID());
  await expect(development.publish(f.root,{...dd,previewToken:preview.token},randomUUID())).rejects.toMatchObject({statusCode:409});expect((await development.read(f.root)).version).toBe(next.version);
 });
 it('keeps PMC read-only and live roles authoritative, and removes automatic series candidates and profile writes',async()=>{
  const id=randomUUID(),admin={...f.root,authorizationCapability:'access:admin',authorizationCapabilities:['access:admin','master_data:manage']};
  await f.db.query('INSERT INTO app_users(id,display_name,enabled) VALUES($1,$2,true)',[id,'TEST paired settings PMC']);
  await f.db.query("INSERT INTO identity_mappings(id,user_id,provider,corp_id,provider_user_id,union_id,active,employed,last_verified_at) VALUES($1,$2,'dingtalk','anchor-test',$3,$4,true,true,CURRENT_TIMESTAMP)",[randomUUID(),id,'uat-pair-'+id,'uat-pair-union-'+id]);
  await f.access.assignRole(admin,{userId:id,roleCode:'pmc',reason:'TEST paired read-only'});
  const pmc={...f.root,actorId:id,actorRoles:['pmc']},manager=f.people['production-management']!,draft=input(await read());expect((await sets.read(pmc)).current).toBeDefined();await expect(sets.save(pmc,draft,randomUUID())).rejects.toMatchObject({statusCode:403});
  const service=new SeriesPlanService(f.db);expect(await service.creationPreview(f.root,{customerCode:'PD',salesYear:2027,salesSeries:'P03',requiresColorMatching:true})).toMatchObject({candidateDate:null,milestones:[],basis:'unavailable',suggestionsEnabled:false});expect(await service.profiles(f.root)).toEqual({profiles:[],suggestionsEnabled:false});await expect(service.saveProfile(f.root,{monthOffset:-2,shippingDay:15},randomUUID())).rejects.toMatchObject({statusCode:409});
  const managerDraft=input(await sets.read(manager),'TEST private unpublished manager draft');managerDraft.values.unified.bulk_cutting={kind:'duration',minutes:1980};await sets.save(manager,managerDraft,randomUUID());
  await f.access.assignRole(admin,{userId:manager.actorId,roleCode:'pmc',reason:'TEST published standards readonly after management revocation'});
  const assignment=(await f.db.query("SELECT assignment_id FROM user_role_assignments WHERE user_id=$1 AND role_code='production_management' AND revoked_at IS NULL",[manager.actorId])).rows[0];
  await f.access.assignRole(admin,{userId:manager.actorId,roleCode:'finance_read',reason:'TEST retain independent valid login role'});
  await f.access.revokeRole({...f.root,authorizationCapability:'access:admin',authorizationCapabilities:['access:admin']},assignment.assignment_id,'TEST live settings role revoked');
  await expect(sets.save(manager,draft,randomUUID())).rejects.toMatchObject({statusCode:403});
  const publishedOnly=await sets.read({...manager,actorRoles:['production_management','pmc']});expect(publishedOnly.draft).toBeNull();expect(publishedOnly.basis.unifiedDraftRevision).toBe(0);expect(publishedOnly.current.unified.bulk_cutting).not.toEqual(managerDraft.values.unified.bulk_cutting);
 });
});
