import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {DevelopmentDocumentSchema} from '@dx-rework/contracts/digital-development';
import type {DevelopmentRevision} from '@dx-rework/contracts/digital-development-rounds';
import {businessAnchorFixture} from '../helpers/business-anchor-fixture.js';
import {createHistoricalPatternFixture} from '../helpers/historical-pattern-fixture.js';
import {DigitalProductionIdentityService} from '../../apps/api/src/production-platform/identity-service.js';
import {DigitalDevelopmentService} from '../../apps/api/src/production-platform/development-service.js';
import {DevelopmentRoundService} from '../../apps/api/src/production-platform/development-round-service.js';
import {DevelopmentExecutionService} from '../../apps/api/src/production-platform/development-execution-service.js';
import {PatternRoomOrderService} from '../../apps/api/src/pattern-room/order-service.js';
import {TodoProjectionService} from '../../apps/api/src/todos/projection-service.js';
import {TodoService} from '../../apps/api/src/todos/service.js';

const url=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
(url?describe:describe.skip)('original round publication clocks and inherited attachment history',()=>{
 let f:Awaited<ReturnType<typeof businessAnchorFixture>>,workerPerson:string;
 beforeAll(async()=>{f=await businessAnchorFixture(url!);workerPerson=(await f.db.query('SELECT person_id FROM business_people WHERE app_user_id=$1 AND active',[f.people['pattern-room-worker']!.actorId])).rows[0].person_id;},120000);
 afterAll(async()=>{await f?.dispose();});
 const context=async(mode:'past'|'current'|'future'|'ordinary')=>{
  const at=new Date(Date.now()+(mode==='past'?-7:mode==='future'?7:0)*86400000).toISOString(),scene=mode==='ordinary'?null:await f.scene(at);
  const run=<T>(action:()=>Promise<T>)=>scene?f.runtime.run(scene,f.root,action):action();return {at,scene,run};
 };
 const source=async()=>{
  const forms=new DigitalDevelopmentService(f.db,true),identity=new DigitalProductionIdentityService(f.db,true);
  const {sourceId}=await identity.createSource(f.root,{developmentType:'头版',designStyleNo:`TEST-ROUND-${randomUUID()}`,temporaryStyleNo:null,customerCode:null},randomUUID());
  const document=DevelopmentDocumentSchema.parse({documentFormatVersion:2,sizeQuantities:[1],template:'上衣',quantity:1,sampleSize:'M',orderDate:null,returnDate:null,unit:'inch',sizes:['M'],measurements:[{name:'袖长',values:['6']}],interlining:'',placketInterlining:'',sewingThread:'',buttonholeThread:'',stitchDensity:'',washingIroning:'',packaging:'',formalSizes:'',casualSizes:'',mainLabel:false,mainLabelMethod:'',sizeLabel:false,careLabel:false,instructions:'TEST unchanged making basis',craft:'无',washing:'免洗',materials:[],files:[{attachmentId:await f.image(f.root),kind:'款图'}]});
  const saved=await forms.save(f.root,sourceId,{expectedVersion:0,document},randomUUID());await forms.publish(f.root,sourceId,saved.version,randomUUID());return {sourceId,forms};
 };
 for(const mode of ['past','current','future','ordinary'] as const)it(`${mode}: original plus two revisions keep publication/entry/deadline in the same trusted domain`,async()=>{
  const {at,scene,run}=await context(mode),p=await run(source),rounds=new DevelopmentRoundService(f.db,true);
  const original=(await f.db.query('SELECT to_jsonb(d) AS value FROM digital_development_documents d WHERE source_id=$1',[p.sourceId])).rows[0].value;
  for(const basedOnRound of [1,2]){
   const sheet=await p.forms.read(f.root,p.sourceId),revision:DevelopmentRevision={basedOnRound,document:sheet.document!,origin:'内部发现',customerComment:'',internalProblem:'TEST本轮车缝',explanation:'TEST unchanged source quantity',categories:['车缝'],affectedNodes:['车板'],outputKind:'整件样板'};
   const saved=await run(()=>rounds.save(f.root,p.sourceId,{expectedDraftVersion:0,revision},randomUUID()));
   const key=randomUUID(),input={expectedDraftVersion:saved.draftVersion,basedOnRound},before=Date.now();
   await run(()=>rounds.publish(f.root,p.sourceId,input,key));const after=Date.now();
   const row=(await f.db.query('SELECT published_at,document FROM digital_development_rounds WHERE source_id=$1 AND round_number=$2',[p.sourceId,basedOnRound+1])).rows[0];
   const audit=(await f.db.query("SELECT created_at FROM audit_events WHERE entity_id=$1 AND action='development_round_published' AND after_state->>'roundNumber'=$2",[p.sourceId,String(basedOnRound+1)])).rows[0];
   if(scene)expect(row.published_at.toISOString()).toBe(at);else {expect(row.published_at.getTime()).toBeGreaterThanOrEqual(before);expect(row.published_at.getTime()).toBeLessThanOrEqual(after);}
   expect(audit.created_at.getTime()).toBeGreaterThanOrEqual(before-1000);expect(audit.created_at.getTime()).toBeLessThanOrEqual(after+1000);expect(row.document.quantity).toBe(1);
   const tasks=(await new DevelopmentExecutionService(f.db,true).read(f.root,p.sourceId)).tasks.filter(task=>task.routeVersion===basedOnRound+1&&task.state==='ready');
   expect(tasks.length).toBeGreaterThan(0);for(const task of tasks){
    if(scene&&task.enteredAt)expect(task.enteredAt).toBe(row.published_at.toISOString());
    if(!task.enteredAt){expect(task.timeQuality).toBe('缺失');expect(task.dueAt).toBeNull();}
    else if(task.dueAt&&task.slaHours!==null)expect(task.dueAt).toBe(new Date(Date.parse(task.enteredAt)+task.slaHours*3600000).toISOString());
   }
   await run(()=>rounds.publish(f.root,p.sourceId,input,key));expect((await f.db.query('SELECT count(*)::int n FROM digital_development_rounds WHERE source_id=$1 AND round_number=$2',[p.sourceId,basedOnRound+1])).rows[0].n).toBe(1);
  }
  expect((await f.db.query('SELECT to_jsonb(d) AS value FROM digital_development_documents d WHERE source_id=$1',[p.sourceId])).rows[0].value).toEqual(original);
 },60000);
 for(const mode of ['past','current','future','ordinary'] as const)it(`${mode}: inherited objects retain all three round histories without later binding or wage pollution`,async()=>{
  const {at,scene,run}=await context(mode),native=new PatternRoomOrderService(f.db,new TodoProjectionService(new TodoService(f.db)),{ordersEnabled:true});
  const price=(await f.db.query("SELECT price_id,version FROM pattern_room_prices WHERE kind='category' AND enabled AND amount IS NOT NULL LIMIT 1")).rows[0];
  const ids=[await f.image(f.root),await f.image(f.root),await f.image(f.root)];
  let order=await run(()=>createHistoricalPatternFixture(native,f.root,{styleNo:'TEST three frozen rounds',categoryId:price.price_id,priceVersion:price.version,quantity:1,attachmentIds:[ids[0]],note:'TEST original'},randomUUID()));
  const expected:Array<{id:string;files:string[];wages:unknown}>=[];
  for(let index=0;index<3;index++){
   order=await run(()=>native.assign(f.root,order.orderId,{version:order.version,roundId:order.currentRoundId,personId:workerPerson,...(index?{amount:'0'}:{})},randomUUID()));
   order=await run(()=>native.complete(f.root,order.orderId,{version:order.version,roundId:order.currentRoundId},randomUUID()));
   order=await run(()=>native.handoff(f.root,order.orderId,{version:order.version,roundId:order.currentRoundId},randomUUID()));
   const round=order.currentRoundId;if(scene)expect(order.rounds.find(r=>r.roundId===round)!.completedAt).toBe(at);
   const wages=(await f.db.query('SELECT to_jsonb(s) AS snapshot FROM pattern_room_segments s WHERE round_id=$1 ORDER BY segment_id',[round])).rows;
   expected.push({id:round,files:ids.slice(0,index+1) as string[],wages});
   if(index<2)order=await run(()=>native.requestRework(f.root,order.orderId,{version:order.version,roundId:round,reason:'TEST retain originals and add one',reasonCategory:'workmanship',attachmentIds:[ids[index+1]]},randomUUID()));
  }
  const snapshot=JSON.stringify((await f.db.query('SELECT to_jsonb(b) AS snapshot FROM pattern_room_attachment_bindings b WHERE order_id=$1 ORDER BY round_id,attachment_id',[order.orderId])).rows);
  for(const round of expected){const history=await native.get(f.root,order.orderId,{round:round.id,node:'completed'});expect(history.attachments.map(file=>file.attachmentId).sort()).toEqual([...round.files].sort());expect(history.historicalView).toMatchObject({missingFacts:false});expect(Object.values(history.actions).every(value=>!value)).toBe(true);expect((await f.db.query('SELECT to_jsonb(s) AS snapshot FROM pattern_room_segments s WHERE round_id=$1 ORDER BY segment_id',[round.id])).rows).toEqual(round.wages);}
  expect(JSON.stringify((await f.db.query('SELECT to_jsonb(b) AS snapshot FROM pattern_room_attachment_bindings b WHERE order_id=$1 ORDER BY round_id,attachment_id',[order.orderId])).rows)).toBe(snapshot);
  await expect(native.get(f.people['worker-b']!,order.orderId,{round:expected[0]!.id,node:'completed'})).rejects.toMatchObject({statusCode:403});
 },60000);
 for(const sameKey of [true,false])it(`${sameKey?'same':'distinct'}-key concurrent publication appends once; later clock observation never restarts the saved anchor`,async()=>{
  const {at,scene,run}=await context('past'),p=await run(source),service=new DevelopmentRoundService(f.db,true),sheet=await p.forms.read(f.root,p.sourceId);
  const revision:DevelopmentRevision={basedOnRound:1,document:sheet.document!,origin:'内部发现',customerComment:'',internalProblem:'TEST concurrent seam',explanation:'TEST serialized original command',categories:['车缝'],affectedNodes:['车板'],outputKind:'整件样板'};
  const saved=await run(()=>service.save(f.root,p.sourceId,{expectedDraftVersion:0,revision},randomUUID())),input={basedOnRound:1,expectedDraftVersion:saved.draftVersion},first=randomUUID(),keys=[first,sameKey?first:randomUUID()];
  const outcomes=await Promise.allSettled(keys.map(key=>run(()=>service.publish(f.root,p.sourceId,input,key))));
  expect(outcomes.filter(x=>x.status==='fulfilled')).toHaveLength(sameKey?2:1);for(const result of outcomes)if(result.status==='rejected')expect(result.reason).toMatchObject({statusCode:409});
  const rows=(await f.db.query('SELECT published_at FROM digital_development_rounds WHERE source_id=$1',[p.sourceId])).rows;expect(rows).toHaveLength(1);expect(rows[0].published_at.toISOString()).toBe(at);
  const snapshot=async()=>JSON.stringify((await f.db.query('SELECT to_jsonb(t) AS snapshot,(SELECT jsonb_agg(to_jsonb(r) ORDER BY revision_id) FROM digital_production_deadline_revisions r WHERE r.task_id=t.task_id) AS revisions FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) WHERE a.source_id=$1 ORDER BY t.task_id',[p.sourceId])).rows);
  const before=await snapshot();await f.advance(scene!,new Date(Date.parse(at)+1000).toISOString());const winner=outcomes.findIndex(result=>result.status==='fulfilled');await run(()=>service.publish(f.root,p.sourceId,input,keys[winner]!));expect(await snapshot()).toBe(before);
 },60000);
});
