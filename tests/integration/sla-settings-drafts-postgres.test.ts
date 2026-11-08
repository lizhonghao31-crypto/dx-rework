import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {businessAnchorFixture} from '../helpers/business-anchor-fixture.js';
import {SlaSettingsDraftService} from '../../apps/api/src/production-platform/sla-settings-drafts.js';
import {DigitalProductionTaskService} from '../../apps/api/src/production-platform/task-service.js';
import {DevelopmentTechnicalSettingsService} from '../../apps/api/src/production-platform/development-technical-settings.js';
import type {TrustedActorContext} from '../../apps/api/src/tools/repositories.js';
import type {SlaDraftSave} from '@dx-rework/contracts/sla-settings-drafts';

const url=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
(url?describe.sequential:describe.skip)('Final10 own persistent settings drafts on the original current PostgreSQL fixture',()=>{
 let f:Awaited<ReturnType<typeof businessAnchorFixture>>|undefined,drafts:SlaSettingsDraftService,tasks:DigitalProductionTaskService,development:DevelopmentTechnicalSettingsService;
 let manager:TrustedActorContext,owner:TrustedActorContext,viewer:TrustedActorContext,managerAssignment:string;
 const fixture=()=>{if(!f)throw Error('Original owned fixture not ready');return f;};
 const administrator=()=>({...fixture().root,requestId:randomUUID(),authorizationCapability:'access:admin',authorizationCapabilities:['access:admin','master_data:manage']});
 const dedicated=async(role:string)=>{
  const {db,access}=fixture(),id=randomUUID();await db.query("INSERT INTO app_users(id,display_name,enabled) VALUES($1,$2,true)",[id,`TEST own settings draft ${role}`]);
  await db.query("INSERT INTO identity_mappings(id,user_id,provider,corp_id,provider_user_id,union_id,active,employed,last_verified_at) VALUES($1,$2,'dingtalk','anchor-test',$3,$4,true,true,CURRENT_TIMESTAMP)",[randomUUID(),id,`uat-draft-${id.replaceAll('-','')}`,`uat-draft-union-${id.replaceAll('-','')}`]);
  const assignment=await access.assignRole(administrator(),{userId:id,roleCode:role,reason:'TEST isolated settings draft role'});
  return {actor:{actorId:id,actorRoles:[role],authorizationCapability:'digital_production:tasks',requestId:randomUUID()} as TrustedActorContext,assignment:assignment.assignmentId};
 };
 const unchangedBusiness=async()=>Object.fromEntries(await Promise.all(['digital_sla_configurations','digital_sla_order_snapshots','digital_sla_plans','digital_production_tasks','digital_production_task_events','digital_development_cycle_standards'].map(async table=>[table,Number((await fixture().db.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n)])));
 const unified=async(actor:TrustedActorContext):Promise<Extract<SlaDraftSave,{group:'unified'}>>=>{
  const current=await tasks.slaSettings(actor),head=await drafts.read(actor,'unified'),values=structuredClone(current.values),warning=values.warning_ratio!;if(warning.kind!=='ratio')throw Error('Original warning contract missing');values.warning_ratio={...warning,percent:warning.percent===71?72:71};
  return {group:'unified',expectedVersion:current.version,expectedDraftRevision:head.revision,values,reason:'TEST personal draft, explicit publication remains separate'};
 };
 beforeAll(async()=>{
  f=await businessAnchorFixture(url!);const secret='TEST only original settings draft publication '.repeat(3);drafts=new SlaSettingsDraftService(f.db);tasks=new DigitalProductionTaskService(f.db,secret);development=new DevelopmentTechnicalSettingsService(f.db,true,secret);
  // The original run-owned fixture already has the sole active production
  // manager. Reuse that account; never relax the singleton business guard.
  manager={...f.people['production-management']!,authorizationCapability:'digital_production:tasks'};
  managerAssignment=(await f.db.query("SELECT assignment_id FROM user_role_assignments WHERE user_id=$1 AND role_code='production_management' AND revoked_at IS NULL",[manager.actorId])).rows[0].assignment_id;
  owner=(await dedicated('owner_group')).actor;viewer=(await dedicated('pmc')).actor;
 });
 afterAll(async()=>{await f?.dispose();});
 it('saves a version0 baseline without publishing or changing any order/task and isolates actors',async()=>{
  const before=await unchangedBusiness(),input=await unified(manager);expect(input.expectedVersion).toBe(0);input.reason='';
  const result=await drafts.save(manager,input,randomUUID());expect(result.saved.revision).toBe(1);expect(result.saved.expectedVersion).toBe(0);expect(result.currentStandardVersion).toBe(0);
  const refreshed=await new SlaSettingsDraftService(fixture().db).read(manager,'unified');expect(refreshed.draft).toEqual(result.saved);if(result.saved.group!=='unified')throw Error('Wrong saved group');expect(result.saved.baselineValues.warning_ratio).toEqual({kind:'ratio',percent:70});
  expect((await drafts.read(owner,'unified')).draft).toBeNull();expect((await drafts.read(manager,'development')).draft).toBeNull();expect(await unchangedBusiness()).toEqual(before);
 });
 it('commits one draft for concurrent exact-key retries and rejects changed content on that key',async()=>{
  const input=await unified(fixture().root),key=randomUUID(),result=await Promise.all([drafts.save(fixture().root,input,key),drafts.save(fixture().root,structuredClone(input),key)]);
  expect(result[0]).toEqual(result[1]);expect(result[0]!.saved.revision).toBe(input.expectedDraftRevision+1);await expect(drafts.save(fixture().root,{...input,reason:'TEST different content'},key)).rejects.toMatchObject({statusCode:409});
 });
 it('serializes two browser drafts and keeps the rejected browser input outside persistence',async()=>{
  const input=await unified(fixture().root),before=await drafts.read(fixture().root,'unified'),results=await Promise.allSettled([drafts.save(fixture().root,input,randomUUID()),drafts.save(fixture().root,{...input,reason:'TEST another browser'},randomUUID())]);
  expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);expect(results.filter(result=>result.status==='rejected')).toHaveLength(1);expect((await drafts.read(fixture().root,'unified')).revision).toBe(before.revision+1);
 });
 it('retains the trusted old baseline after a legacy publication and rejects a stale save',async()=>{
  const old=await drafts.read(manager,'unified'),current=await tasks.slaSettings(fixture().root),values=structuredClone(current.values);values.bulk_cutting={kind:'duration',minutes:1500};
  const input={expectedVersion:current.version,values,reason:'TEST legacy publisher remains compatible'},preview=await tasks.previewSlaSettings(fixture().root,input),key=randomUUID(),result=await tasks.publishSlaSettings(fixture().root,{...input,previewToken:preview.token},key);
  expect(result.existingOrdersChanged).toBe(0);expect(await tasks.publishSlaSettings(fixture().root,{...input,previewToken:preview.token},key)).toEqual(result);
  const refreshed=await drafts.read(manager,'unified');expect(refreshed.draft).toEqual(old.draft);expect(refreshed.currentStandardVersion).toBe(result.version);expect(refreshed.draft?.expectedVersion).toBe(0);
  if(!old.draft||old.draft.group!=='unified')throw Error('Original personal draft missing');expect(old.draft.baselineValues.bulk_cutting).toEqual({kind:'duration',minutes:1440});await expect(drafts.save(manager,{group:'unified',expectedVersion:0,expectedDraftRevision:old.revision,values:old.draft.values,reason:'TEST stale'},randomUUID())).rejects.toMatchObject({statusCode:409});
 });
 it('publishes only the exact saved draft atomically and never consumes a later draft during retry',async()=>{
  const input=await unified(owner),saved=await drafts.save(owner,input,randomUUID()),preview=await tasks.previewSlaSettings(owner,input),key=randomUUID(),command={expectedVersion:input.expectedVersion,values:input.values,reason:input.reason,previewToken:preview.token,savedDraftRevision:saved.saved.revision};
  const result=await tasks.publishSlaSettings(owner,command,key);expect((await drafts.read(owner,'unified')).draft).toBeNull();const later=await drafts.save(owner,await unified(owner),randomUUID());
  expect(await tasks.publishSlaSettings(owner,command,key)).toEqual(result);expect((await drafts.read(owner,'unified')).draft).toEqual(later.saved);await expect(tasks.publishSlaSettings(owner,{...command,savedDraftRevision:later.saved.revision},key)).rejects.toMatchObject({statusCode:409});const {savedDraftRevision:ignored,...withoutRef}=command;void ignored;await expect(tasks.publishSlaSettings(owner,withoutRef,key)).rejects.toMatchObject({statusCode:409});
 });
 it('keeps development drafts and new-source publication independent from unified policy and old facts',async()=>{
  const before=await tasks.slaSettings(owner),current=await development.read(owner),head=await drafts.read(owner,'development'),input={group:'development' as const,expectedVersion:current.version,expectedDraftRevision:head.revision,values:{...current.values,normalDays:current.values.normalDays+1},reason:'TEST independent saved development cycle'},saved=await drafts.save(owner,input,randomUUID()),preview=await development.preview(owner,{expectedVersion:input.expectedVersion,values:input.values,reason:input.reason}),key=randomUUID();
  const command={expectedVersion:input.expectedVersion,values:input.values,reason:input.reason,previewToken:preview.token,savedDraftRevision:saved.saved.revision},result=await development.publish(owner,command,key);expect(result).toMatchObject({scope:'new_sources',existingSourcesChanged:0});expect(await development.publish(owner,command,key)).toEqual(result);expect((await drafts.read(owner,'development')).draft).toBeNull();expect((await tasks.slaSettings(owner)).values).toEqual(before.values);
 });
 it('reports a superseded discard honestly and retains immutable draft history',async()=>{
  const head=await drafts.read(manager,'unified'),command={group:'unified' as const,expectedDraftRevision:head.revision},key=randomUUID(),removed=await drafts.discard(manager,command,key);expect(removed.draft).toBeNull();const later=await drafts.save(manager,await unified(manager),randomUUID()),retry=await drafts.discard(manager,command,key);
  expect(retry.superseded).toBe(true);expect(retry.discardedRevision).toBe(removed.discardedRevision);expect(retry.draft).toEqual(later.saved);await expect(drafts.discard(manager,{...command,expectedDraftRevision:later.saved.revision},key)).rejects.toMatchObject({statusCode:409});await expect(fixture().db.query("UPDATE digital_sla_settings_drafts SET reason='TEST forbidden rewrite' WHERE actor_id=$1",[manager.actorId])).rejects.toThrow();
 });
 it('rejects illegal included targets without appending a partial draft',async()=>{
  const input=await unified(fixture().root),before=await drafts.read(fixture().root,'unified');input.values.development_printing={kind:'duration',minutes:30};await expect(drafts.save(fixture().root,input,randomUUID())).rejects.toMatchObject({statusCode:400});expect(await drafts.read(fixture().root,'unified')).toEqual(before);
 });
 it('denies PMC personal drafts and rechecks a real revoked manager role on the service boundary',async()=>{
  await expect(drafts.read(viewer,'unified')).rejects.toMatchObject({statusCode:403});await expect(drafts.save(viewer,await unified(owner),randomUUID())).rejects.toMatchObject({statusCode:403});const input=await unified(manager);await fixture().access.assignRole(administrator(),{userId:manager.actorId,roleCode:'sample_designer',reason:'TEST retain an unrelated active login role'});await fixture().access.revokeRole(administrator(),managerAssignment,'TEST revoke only this owned manager role');await expect(drafts.read(manager,'unified')).rejects.toMatchObject({statusCode:403});await expect(drafts.save(manager,input,randomUUID())).rejects.toMatchObject({statusCode:403});
 });
});
