import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {expect,it,vi} from 'vitest';
import {prepareTimeFrameworkConfiguration} from '@dx-rework/contracts/order-time-settings';
import {DevelopmentDocumentSchema} from '@dx-rework/contracts/digital-development';
import {businessAnchorFixture} from '../helpers/business-anchor-fixture.js';
import {r5OneHourConfiguration} from '../helpers/r5-order-time-fixture.js';
import {assertTestDatabaseTarget} from '../../scripts/test-database-safety.mjs';
import {verifyAcceptanceClockServer} from '../../apps/api/src/acceptance-clock/guard.js';
import {AcceptanceClockRuntime} from '../../apps/api/src/acceptance-clock/runtime.js';
import {ContextBusinessClock} from '../../apps/api/src/acceptance-clock/business-time.js';
import {DigitalProductionIdentityService} from '../../apps/api/src/production-platform/identity-service.js';
import {DigitalDevelopmentService} from '../../apps/api/src/production-platform/development-service.js';
import {DevelopmentRoundService} from '../../apps/api/src/production-platform/development-round-service.js';
import {FixedTimelineAdoptionRepository,fixedConsumerTargets} from '../../apps/api/src/production-platform/fixed-timeline-adoptions.js';
import {DigitalJourneyQuery} from '../../apps/api/src/production-platform/journey-query.js';
import {JourneyFactRepository} from '../../apps/api/src/production-platform/journey-fact-repository.js';
import {JourneyFactUpdates} from '../../apps/api/src/production-platform/journey-fact-updates.js';
import {JOURNEY_FACT_CALCULATION_VERSION} from '../../apps/api/src/production-platform/journey-fact-model.js';
import {OrderTimeSettingsService} from '../../apps/api/src/production-platform/order-time-settings-service.js';
import {PatternRoomOrderService} from '../../apps/api/src/pattern-room/order-service.js';
import {TodoProjectionService} from '../../apps/api/src/todos/projection-service.js';
import {TodoService} from '../../apps/api/src/todos/service.js';

const url=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL;

(url?it:it.skip)('rebuilds one source-only embroidery revision as a restricted application role',async()=>{
 const fixture=await businessAnchorFixture(url!);
 let app:pg.Pool|undefined;
 try {
  const f=fixture;
  const {schema}=(await f.db.query('SELECT current_schema() schema')).rows[0];
  if(!/^business_anchors_[a-z0-9_]+$/.test(schema)) throw Error('Expected the fixture-owned schema');
  await f.db.query(`GRANT USAGE ON SCHEMA "${schema}" TO dx_rework_acceptance_app;
    GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA "${schema}" TO dx_rework_acceptance_app;
    GRANT SELECT ON ALL SEQUENCES IN SCHEMA "${schema}" TO dx_rework_acceptance_app;`);
  // The canonical PG worker provisions this role and grants it to the
  // fixture login. Only the worker connections adopt it, never the owner.
  const appOptions=`-c search_path=${schema} -c role=dx_rework_acceptance_app`;
  app=new pg.Pool({connectionString:url,options:appOptions,max:2,connectionTimeoutMillis:3000});
  const appIdentity=new URL(url!);
  appIdentity.username='dx_rework_acceptance_app';
  const db=app,identity=await assertTestDatabaseTarget(appIdentity.toString(),db);
  expect(identity).toMatchObject({isSuperuser:false,canBypassRls:false});
  const permissions=(await db.query(`SELECT current_user AS role, current_schema()=$1 AS fixture_schema,
    NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=$1 AND c.relkind IN ('r','p') AND pg_has_role(current_user,c.relowner,'USAGE')) AS no_table_owner,
    has_table_privilege(current_user,'digital_timeline_adoptions','SELECT') AS adoption_select,
    has_table_privilege(current_user,'digital_timeline_adoptions','UPDATE') AS adoption_row_lock,
    has_table_privilege(current_user,'digital_timeline_target_revisions','INSERT') AS target_insert,
    has_table_privilege(current_user,'digital_journey_fact_changes','DELETE') AS queue_delete`,[schema])).rows[0];
  expect(permissions).toEqual({role:'dx_rework_acceptance_app',fixture_schema:true,no_table_owner:true,adoption_select:true,adoption_row_lock:true,target_insert:true,queue_delete:true});
  const config={NODE_ENV:'test',ACCEPTANCE_LAB_ENABLED:'true',DINGTALK_CORP_ID:'anchor-test',ROOT_DINGTALK_USER_ID:'uat-root'};
  new AcceptanceClockRuntime(db,await verifyAcceptanceClockServer(db,url!,config),'TEST-synthetic-rebuild-proof-'.repeat(2),true);
  const owner=f.db,native=new PatternRoomOrderService(owner,new TodoProjectionService(new TodoService(owner)),{ordersEnabled:true});
  const forms=new DigitalDevelopmentService(owner,true,native);
  const actorBase=f.people['sample-designer']!,actor={...actorBase,authorizationCapabilities:[...actorBase.authorizationCapabilities!,'pattern_room:orders:view']};
  // A managed source without an assigned guarded clock has native revision 0.
  const completionDate=new Date(Date.now()+35*86_400_000).toISOString().slice(0,10);
  const settings=new OrderTimeSettingsService(owner,true,true);
  const standard=await settings.read(f.root);
  await settings.save(f.root,{expectedVersion:standard.version,values:prepareTimeFrameworkConfiguration(r5OneHourConfiguration())},randomUUID());
  const sourceId=await (async()=>{
    const {sourceId}=await new DigitalProductionIdentityService(owner,true).createSource(actor,
      {developmentType:'头版',designStyleNo:'TEST-rebuild-'+randomUUID(),temporaryStyleNo:null,customerCode:null},randomUUID());
    const document=DevelopmentDocumentSchema.parse({documentFormatVersion:2,sizeQuantities:[1],template:'上衣',quantity:1,sampleSize:'M',orderDate:null,returnDate:completionDate,unit:'cm',sizes:['M'],measurements:[{name:'胸围',values:['50']}],interlining:'',placketInterlining:'',sewingThread:'',buttonholeThread:'',stitchDensity:'',washingIroning:'',packaging:'',formalSizes:'',casualSizes:'',mainLabel:false,mainLabelMethod:'',sizeLabel:false,careLabel:false,instructions:'TEST isolated',craft:'无',washing:'免洗',materials:[],files:[{attachmentId:await f.image(actor),kind:'款图'}]});
    const sheet=await forms.save(actor,sourceId,{expectedVersion:0,document},randomUUID());
    const {price_id,version}=(await owner.query("SELECT price_id,version FROM pattern_room_prices WHERE kind='category' AND enabled ORDER BY price_id LIMIT 1")).rows[0];
    await forms.publish(actor,sourceId,sheet.version,randomUUID(),{categoryId:price_id,priceVersion:version});
    return sourceId;
  })();
  const scope={kind:'source' as const,id:sourceId};
  const repo=new JourneyFactRepository(db);
  const state=async()=>{
    const metadata=(await db.query(`SELECT order_time_managed,
      EXISTS(SELECT 1 FROM digital_order_time_subjects t WHERE t.source_id=s.source_id AND t.effective) AS effective_subject,
      EXISTS(SELECT 1 FROM digital_production_orders o WHERE o.source_id=s.source_id) AS linked_order
      FROM digital_production_sources s WHERE source_id=$1`,[sourceId])).rows[0];
    const targets=(await db.query(`SELECT a.round_number AS round,count(t.target_revision_id)::int AS saved
      FROM digital_timeline_adoptions a LEFT JOIN digital_timeline_target_revisions t USING(adoption_id)
      WHERE a.source_id=$1 GROUP BY a.round_number ORDER BY a.round_number`,[sourceId])).rows;
    const model=(await db.query(`SELECT calculation_version,source_version,applied_source_version,clock_revision,
      payload IS NOT NULL AS payload,selection_json IS NOT NULL AS selector,selection_full_json IS NOT NULL AS full_selector
      FROM digital_journey_fact_models WHERE resource_kind='source' AND resource_id=$1`,[sourceId])).rows[0]??null;
    const changes=(await db.query(`SELECT reason,count(*)::int AS count FROM digital_journey_fact_changes
      WHERE resource_kind='source' AND resource_id=$1 GROUP BY reason ORDER BY reason`,[sourceId])).rows;
    const retry=(await db.query(`SELECT attempts,error_code FROM digital_journey_fact_retries
      WHERE resource_kind='source' AND resource_id=$1`,[sourceId])).rows[0]??null;
    return {metadata,targets,model,changes,retry};
  };
  const history=async()=>(await db.query(`SELECT
   (SELECT md5(to_jsonb(s)::text) FROM digital_production_sources s WHERE source_id=$1) AS source,
   (SELECT md5(jsonb_agg(to_jsonb(a) ORDER BY a.round_number)::text) FROM digital_timeline_adoptions a WHERE a.source_id=$1) AS adoptions,
   (SELECT md5(jsonb_agg(to_jsonb(p) ORDER BY p.revision)::text) FROM digital_order_time_plan_versions p WHERE p.source_id=$1) AS plans,
   (SELECT md5(jsonb_agg(to_jsonb(t) ORDER BY t.scope_ref,t.revision)::text)
    FROM digital_timeline_target_revisions t JOIN digital_timeline_adoptions a USING(adoption_id)
    WHERE a.source_id=$1 AND a.round_number=1) AS first_round_targets,
   (SELECT md5(jsonb_agg(to_jsonb(t) ORDER BY t.task_id)::text)
    FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) WHERE a.source_id=$1) AS tasks,
   (SELECT md5(jsonb_agg(to_jsonb(d) ORDER BY d.revision_id)::text)
    FROM digital_production_deadline_revisions d JOIN digital_production_task_access a USING(task_id) WHERE a.source_id=$1) AS responsibility,
   (SELECT md5(jsonb_agg(to_jsonb(e) ORDER BY e.event_id)::text)
    FROM digital_production_task_events e JOIN digital_production_task_access a USING(task_id) WHERE a.source_id=$1) AS task_events`,[sourceId])).rows[0];
  const first=await repo.buildOne(scope);
  expect(first.model.orderId).toBeNull();
  const oldVersion='journey-facts-native-window-v10';
  // Preserve the fully stored native round-1 result, and emulate only the
  // v10 tag. This does not claim that v10 code or data was run.
  await owner.query(`UPDATE digital_journey_fact_models SET calculation_version=$2
   WHERE resource_kind='source' AND resource_id=$1`,[sourceId,oldVersion]);
  const initial=await state();
  expect(initial.targets).toEqual([{round:1,saved:1}]);
  expect(initial.changes).toEqual([]);

  await (async()=>{
    const sheet=await forms.read(actor,sourceId),rounds=new DevelopmentRoundService(owner,true,native);
    const saved=await rounds.save(actor,sourceId,{expectedDraftVersion:0,revision:{
      basedOnRound:1,document:{...sheet.document!,craft:'绣花',craftSteps:[{craftKind:'embroidery',sequence:1}]},
      origin:'内部发现',customerComment:'',internalProblem:'TEST add embroidery',explanation:'TEST original revision',
      categories:['工艺'],affectedNodes:['工艺','纸样','车板'],outputKind:'整件样板',
    }},randomUUID());
    expect(await rounds.publish(actor,sourceId,{expectedDraftVersion:saved.draftVersion,basedOnRound:1},randomUUID())).toMatchObject({sourceId,roundNumber:2});
  })();
  const before=await state();
  expect(before.metadata).toEqual({order_time_managed:true,effective_subject:true,linked_order:false});
  expect(before.targets).toEqual([{round:1,saved:1},{round:2,saved:0}]);
  expect(before.model).toMatchObject({calculation_version:oldVersion,payload:true,selector:true,full_selector:true});
  expect(before.changes.length).toBeGreaterThan(0);
  expect(before.retry).toBeNull();

  const client=await db.connect();
  let expectedRoundTwo:unknown;
  try {
    await client.query('BEGIN READ ONLY');
    const timeline=new FixedTimelineAdoptionRepository(client);
    const pending=await timeline.existing(scope,2);
    if(!pending)throw Error('Round 2 frozen inputs missing');
    const dryTargets=pending.input.consumers.map(consumer=>({
      scope_ref:consumer.scopeRef,line_id:consumer.lineId,revision:1,goal_anchor:consumer.ends,
      targets_json:fixedConsumerTargets(pending.input.work.filter(work=>consumer.nodeIds.includes(work.id)),consumer),
      source_event_ref:pending.creationEventRef,business_time:pending.time,
    }));
    expectedRoundTwo=dryTargets;
    const clock=await new ContextBusinessClock(db,client).read(scope);
    let frames:number|undefined;
    const facts=await new DigitalJourneyQuery(db).buildFactsWithClient(client,scope,clock.now,result=>{frames=result.facts.frames?.length});
    expect(facts.orderId).toBeNull();
    expect(frames).toBeGreaterThan(0);
    expect(clock.revision).toBe(0);
    await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}

  const historyBefore=await history();
  expect(historyBefore).toEqual(expect.objectContaining({
    source:expect.any(String),adoptions:expect.any(String),plans:expect.any(String),
    first_round_targets:expect.any(String),tasks:expect.any(String),responsibility:expect.any(String),task_events:expect.any(String),
  }));
  const blocker=await owner.connect();
  const shortLockPool=new pg.Pool({connectionString:url,options:appOptions+' -c lock_timeout=250ms',max:2,connectionTimeoutMillis:3000});
  try {
    await blocker.query('BEGIN');
    expect((await blocker.query(`SELECT adoption_id FROM digital_timeline_adoptions
      WHERE source_id=$1 AND round_number=2 FOR UPDATE`,[sourceId])).rowCount).toBe(1);
    let lockCode:unknown;
    const lockedRepo=new JourneyFactRepository(shortLockPool);
    const buildOne=lockedRepo.buildOne.bind(lockedRepo);
    vi.spyOn(lockedRepo,'buildOne').mockImplementation(async (...args)=>{
      expect(args[0]).toEqual(scope);
      try{return await buildOne(...args);}catch(error){lockCode=(error as {code?:string}).code;throw error;}
    });
    const batch=await new JourneyFactUpdates(shortLockPool,lockedRepo).runOnce();
    expect(batch).toEqual({built:0,retired:0,failed:1,busy:0});
    expect(lockCode).toBe('55P03');
    const withRetry=await state();
    expect(withRetry).toEqual({...before,retry:{attempts:1,error_code:'BUILD_FAILED'}});
  } finally {
    await blocker.query('ROLLBACK');
    blocker.release();
    await shortLockPool.end();
  }

  const rebuilt=await repo.buildOne(scope);
  expect(rebuilt.model.orderId).toBeNull();
  const after=await state();
  expect(after.targets).toEqual([{round:1,saved:1},{round:2,saved:1}]);
  expect(after.model).toMatchObject({calculation_version:JOURNEY_FACT_CALCULATION_VERSION,payload:true,selector:true,full_selector:true,clock_revision:'0'});
  expect(after.model.source_version).toBe((BigInt(before.model.source_version)+1n).toString());
  expect(after.model.source_version).toBe(after.model.applied_source_version);
  expect(after.changes).toEqual([]);
  expect(after.retry).toBeNull();
  const verify=await db.connect();
  try {
    const persisted=await new FixedTimelineAdoptionRepository(verify).currentTargets(scope,2);
    expect(persisted?.scopes).toEqual(expectedRoundTwo);
    expect(await repo.readStoredWithClient(verify,scope)).toMatchObject({status:'ready',sourceVersion:after.model.source_version});
    expect(await history()).toEqual(historyBefore);
  } finally {verify.release();}
 } finally {
   await app?.end();
   await fixture.dispose();
 }
},120_000);
