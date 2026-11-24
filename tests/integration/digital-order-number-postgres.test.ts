import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {beijingCalendarDate,DigitalOrderCreateSchema} from '@dx-rework/contracts/digital-production';
import {DevelopmentRevisionSchema} from '@dx-rework/contracts/digital-development-rounds';
import {JourneyFilterSchema} from '@dx-rework/contracts/digital-production-journey';
import type {NumberedDraftInput,OrderNumberContext} from '@dx-rework/contracts/digital-order-number';
import {DigitalProductionIdentityService} from '../../apps/api/src/production-platform/identity-service.js';
import {activateDevelopmentDraft} from '../../apps/api/src/production-platform/development-source-lifecycle.js';
import {DigitalDevelopmentService} from '../../apps/api/src/production-platform/development-service.js';
import {DigitalJourneyQuery} from '../../apps/api/src/production-platform/journey-query.js';
import {DigitalProductionNotificationService} from '../../apps/api/src/production-platform/notification-service.js';
import {DigitalProductionTaskService} from '../../apps/api/src/production-platform/task-service.js';
import {createIndependentDevelopmentRevision} from '../../apps/api/src/production-platform/development-revision-source.js';
import {observedBusinessTime} from '../../apps/api/src/acceptance-clock/business-time.js';
import {initialDevelopmentDocument} from '../../apps/web/src/digital-development-editing.js';
import {businessAnchorFixture} from '../helpers/business-anchor-fixture.js';
import {r5RoleFixture} from '../helpers/r5-role-fixture.js';

const url=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
const day=new Date('2026-11-24T08:00:00Z');
const context=(changes:Partial<OrderNumberContext>={}):OrderNumberContext=>({
  kind:'development',customerCode:'BO',productGroup:'女装',salesYear:2027,salesSeries:'P05',...changes,
});
const draft=(changes:Partial<OrderNumberContext>={}):NumberedDraftInput=>({
  developmentType:'头版',temporaryStyleNo:null,numbering:context(changes),
});

(url?describe.sequential:describe.skip)('X1 original durable workbench order identity',()=>{
  let f:Awaited<ReturnType<typeof businessAnchorFixture>>,service:DigitalProductionIdentityService;
  let designer:Awaited<ReturnType<typeof businessAnchorFixture>>['root'];
  beforeAll(async()=>{
    f=await businessAnchorFixture(url!);
    service=new DigitalProductionIdentityService(f.db,true,undefined,()=>day);
    designer=f.people['sample-designer']!;
    await f.db.query("UPDATE app_users SET display_name='李辉' WHERE id=$1",[designer.actorId]);
    await f.db.query("INSERT INTO digital_production_customers(code,name,product_groups) VALUES('BO','TEST BO',ARRAY['男装','女装','男童']),('BOM','TEST BOM',ARRAY['女装'])");
  },60_000);
  afterAll(async()=>{await f?.dispose();});

  it('authorizes only current settings administrators and validates normalized, unambiguous code maps',async()=>{
    const root=f.root,manager=f.people['production-management']!;
    const read=await service.orderNumberSettings(root);
    expect(read.designers).toContainEqual({userId:designer.actorId,name:'李辉',suggestion:'LH',needsReview:false});
    expect(await service.orderNumberSettings(manager)).toEqual(read);
    await expect(service.orderNumberSettings(designer)).rejects.toMatchObject({statusCode:403});
    await expect(service.orderNumberSettings(f.people.owner!)).rejects.toMatchObject({statusCode:403});
    const values={boys:'B',girls:'G',designers:[{userId:designer.actorId,code:'LH'}]};
    await expect(service.saveOrderNumberSettings(root,{expectedVersion:0,...values,boys:'M'},randomUUID())).rejects.toThrow('产品分类代码必须互不重复');
    await expect(service.saveOrderNumberSettings(root,{expectedVersion:0,...values,boys:'MW'},randomUUID())).rejects.toThrow('相同前缀');
    await expect(service.saveOrderNumberSettings(root,{expectedVersion:0,...values,designers:[...values.designers,values.designers[0]!]},randomUUID())).rejects.toThrow('必须唯一');
    await f.db.query("INSERT INTO digital_production_customers(code,name,product_groups) VALUES('bo','TEST duplicate normalized',ARRAY['女装'])");
    await expect(service.saveOrderNumberSettings(root,{expectedVersion:0,...values},randomUUID())).rejects.toThrow('相同前缀');
    await f.db.query("UPDATE digital_production_customers SET enabled=false WHERE code='bo'");
    const body={expectedVersion:0,...values},key=randomUUID();
    const saved=await service.saveOrderNumberSettings(manager,body,key);
    expect(saved.version).toBe(1);
    expect(await service.saveOrderNumberSettings(manager,body,key)).toEqual(saved);
    await expect(service.saveOrderNumberSettings(root,body,randomUUID())).rejects.toThrow('设置已更新');
    await expect(service.saveOrderNumberSettings(designer,{...body,expectedVersion:1},randomUUID())).rejects.toMatchObject({statusCode:403});
    const mapCases=[
      [context(),'BOWLH2027P05-001'],[context({productGroup:'男装'}),'BOMLH2027P05-001'],
      [context({salesSeries:null}),'BOWLH2027P00-001'],
      [context({customerCode:null}),'DEVWLH2027P05-001'],
      [context({customerCode:null,salesSeries:null}),'DEVWLH2027P00-001'],
    ] as const;
    for(const [input,example] of mapCases)expect(await service.previewOrderNumber(root,{...input,designerId:designer.actorId})).toMatchObject({example});
    expect(await service.previewOrderNumber(root,{...context({kind:'preorder',customerCode:null,salesSeries:null,salesYear:null}),designerId:designer.actorId}))
      .toEqual({missing:['销售年份','客户','销售系列']});
    expect((await f.db.query('SELECT count(*)::int AS count FROM digital_order_number_series')).rows[0].count).toBe(0);
  });

  it('resumes the same unnumbered original draft, cannot publish it, and allocates two different numbers in concurrent original transactions',async()=>{
    const incomplete=draft({salesYear:null}),firstKey=randomUUID();
    const first=await service.reserveNumberedDraft(designer,incomplete,firstKey);
    expect(first.orderNumber).toBeNull();
    expect(await service.reserveNumberedDraft(designer,incomplete,firstKey)).toEqual(first);
    expect((await service.developmentDrafts(designer,1,'')).items).toContainEqual(expect.objectContaining({sourceId:first.sourceId,designStyleNo:null}));
    const db=await f.db.connect();
    try {
      await db.query('BEGIN');
      await expect(activateDevelopmentDraft(db,designer,first.sourceId,observedBusinessTime(()=>day))).rejects.toThrow('订单ID生成后才能发布');
    } finally {
      await db.query('ROLLBACK');
      db.release();
    }
    const second=await service.reserveNumberedDraft(designer,incomplete,randomUUID());
    const historical=await service.createSource(designer,{developmentType:'头版',designStyleNo:'BOWLH2027P05-001',temporaryStyleNo:null,customerCode:'BO'},randomUUID(),true);
    const bindKey=randomUUID();
    const [a,b]=await Promise.all([
      service.bindDraftNumber(designer,first.sourceId,context(),bindKey),
      service.bindDraftNumber(f.root,second.sourceId,context(),randomUUID()),
    ]);
    expect([a.orderNumber,b.orderNumber].sort()).toEqual(['BOWLH2027P05-002','BOWLH2027P05-003']);
    expect(a.sourceId).toBe(first.sourceId);
    expect(b.sourceId).toBe(second.sourceId);
    expect(await service.bindDraftNumber(designer,first.sourceId,context(),bindKey)).toEqual(a);
    expect(await service.bindDraftNumber(designer,a.sourceId,context({customerCode:'PD',salesYear:2028,salesSeries:'P03'}),randomUUID())).toEqual(a);
    expect((await service.developmentDrafts(designer,1,a.orderNumber!)).items.map(item=>item.sourceId)).toEqual([a.sourceId]);
    const versions=(await f.db.query('SELECT source_id,design_style_no FROM digital_production_sources WHERE source_id=ANY($1::uuid[])',
      [[historical.sourceId,a.sourceId,b.sourceId]])).rows;
    expect(versions).toContainEqual({source_id:historical.sourceId,design_style_no:'BOWLH2027P05-001'});
    expect((await f.db.query('SELECT count(*)::int AS count FROM digital_order_time_subjects WHERE source_id=ANY($1::uuid[])',[[a.sourceId,b.sourceId]])).rows[0].count).toBe(0);
    await expect(f.db.query("UPDATE digital_production_sources SET design_style_no='NEW' WHERE source_id=$1",[a.sourceId])).rejects.toMatchObject({code:'55000'});
    await expect(f.db.query('DELETE FROM digital_order_number_claims WHERE source_id=$1',[a.sourceId])).rejects.toMatchObject({code:'55000'});
    const deletion=await service.deletions().preview(f.root,{ids:[a.sourceId]});
    expect((await service.deletions().remove(f.root,{orders:deletion.orders.map(({id,revision})=>({id,revision}))},randomUUID())).results)
      .toEqual([{id:a.sourceId,status:'deleted'}]);
    expect((await service.reserveNumberedDraft(designer,draft(),randomUUID())).orderNumber).toBe('BOWLH2027P05-004');
  });

  it('retains the pure development DEV/P00 issue and formal PO identity under real publication and confirmation',async()=>{
    const input=draft({customerCode:null,salesSeries:null}),key=randomUUID();
    const saved=await service.reserveNumberedDraft(designer,input,key);
    expect(saved.orderNumber).toBe('DEVWLH2027P00-001');
    expect(await service.reserveNumberedDraft(designer,input,key)).toEqual(saved);
    const forms=new DigitalDevelopmentService(f.db,true,undefined,()=>day);
    const document={...initialDevelopmentDocument(),quantity:1,files:[{attachmentId:await f.image(designer),kind:'款图' as const}]};
    const original=await forms.save(designer,saved.sourceId,{expectedVersion:0,document},randomUUID());
    await forms.publish(designer,saved.sourceId,original.version,randomUUID());
    const orderInput=DigitalOrderCreateSchema.parse({customerCode:'PD',productGroup:'女装',designStyleNo:saved.orderNumber,
      salesYear:2028,salesSeries:'P03',orderDate:beijingCalendarDate(day),lines:[
        {formalPoNo:'TEST-X1-WHITE',color:'白',customerWarehouseArrivalDate:'2027-03-01',sizes:[{size:'M',quantity:6}]},
        {formalPoNo:'TEST-X1-BLACK',color:'黑',customerWarehouseArrivalDate:'2027-03-02',sizes:[{size:'M',quantity:4}]},
      ]});
    await expect(service.createOrder(designer,orderInput,randomUUID())).rejects.toMatchObject({code:'23505'});
    const order=await service.createOrder(designer,orderInput,randomUUID(),saved.sourceId);
    expect(order).toMatchObject({sourceId:saved.sourceId,customerCode:'PD',designStyleNo:saved.orderNumber,salesYear:2028,salesSeries:'P03'});
    expect(order.lines.map(line=>line.formalPoNo)).toEqual(['TEST-X1-WHITE','TEST-X1-BLACK']);
    expect(await service.orders(designer,1,saved.orderNumber!)).toMatchObject({total:1,items:[{productionOrderId:order.productionOrderId}]});
    expect(await service.orders(designer,2,saved.orderNumber!)).toMatchObject({total:1,items:[]});
    expect(await service.sources(designer,1,saved.orderNumber!)).toMatchObject({total:1,items:[{sourceId:saved.sourceId,customerCode:null}]});
    const journeys=new DigitalJourneyQuery(f.db);
    const journey=await journeys.read(designer,saved.sourceId);
    const identity={kind:'production',businessNumber:saved.orderNumber,reason:null};
    expect(journey).toMatchObject({sourceId:saved.sourceId,orderId:order.productionOrderId,designStyleNo:saved.orderNumber,identity});
    expect(journey.lines.map(line=>line.formalStyleNo)).toEqual(['TEST-X1-WHITE','TEST-X1-BLACK']);
    const exported=await journeys.export(f.root,JourneyFilterSchema.parse({search:saved.orderNumber}));
    expect(exported).toMatchObject({total:1,items:[{orderId:order.productionOrderId,identity}]});
    expect((await forms.publishedVersion(designer,saved.sourceId,1,original.version+1)).designStyleNo).toBe(saved.orderNumber);
    const client=await f.db.connect();
    let revision,task;
    try {
      await client.query('BEGIN');
      revision=await createIndependentDevelopmentRevision(client,designer,saved.sourceId,DevelopmentRevisionSchema.parse({
        basedOnRound:1,document,origin:'客户新增要求',customerComment:'TEST 新版',internalProblem:'',
        explanation:'TEST 保留母单编号',categories:['版型'],affectedNodes:['纸样'],outputKind:'整件样板',
      }));
      task=await new DigitalProductionTaskService(f.db).createWithClient(client,f.root,{
        resource:{kind:'order',id:order.productionOrderId},kind:'budget',routeId:randomUUID(),
        routeVersion:1,occurrence:1,assigneeId:designer.actorId,
      });
      await client.query('COMMIT');
    }catch(error){await client.query('ROLLBACK');throw error;}
    finally{client.release();}
    expect(revision.sourceId).not.toBe(saved.sourceId);
    expect(await journeys.read(designer,revision.sourceId)).toMatchObject({
      designStyleNo:saved.orderNumber+' · 复版1',identity:{kind:'development',businessNumber:saved.orderNumber,reason:null},
    });
    const notices=new DigitalProductionNotificationService(f.db);
    await notices.runOnce();
    let claimed;
    for(let index=0;index<12;index++){
      const earlier=(await notices.claim(designer,true)).notification;
      if(!earlier)break;
      if(earlier.route.entityId===task.taskId){claimed=earlier;break;}
      await notices.acknowledge(designer,earlier.eventId);
    }
    expect(claimed).toMatchObject({route:{entityId:task.taskId},context:{
      orderId:order.productionOrderId,businessNumber:saved.orderNumber,poNumbers:['TEST-X1-WHITE','TEST-X1-BLACK'],
    }});
    expect(await service.bindDraftNumber(designer,saved.sourceId,context({customerCode:'PD',salesYear:2028,salesSeries:'P03'}),randomUUID())).toEqual(saved);
  });

  it('expands to 1000, keeps counter history monotonic and refuses reusing an issued stem for another account',async()=>{
    const input=draft({customerCode:null,salesSeries:null,productGroup:'男装'});
    const prefix='DEVMLH2027P00';
    // Isolated large-prefix state for the serialization boundary; first issue below is native.
    await f.db.query('INSERT INTO digital_order_number_series(prefix,components,last_number) VALUES($1,$2,999)',[prefix,{
      customerCode:null,productGroup:'男装',designerId:designer.actorId,salesYear:2027,salesSeries:null,
    }]);
    expect((await service.reserveNumberedDraft(designer,input,randomUUID())).orderNumber).toBe(prefix+'-1000');
    await expect(f.db.query('UPDATE digital_order_number_series SET last_number=1 WHERE prefix=$1',[prefix])).rejects.toMatchObject({code:'55000'});
    const before=await service.orderNumberSettings(f.root);
    const {actor:alternate}=await r5RoleFixture(f.db,f.access,f.root,'sample_designer');
    await f.db.query("UPDATE app_users SET display_name='单乐' WHERE id=$1",[alternate.actorId]);
    expect((await service.orderNumberSettings(f.root)).designers).toContainEqual({
      userId:alternate.actorId,name:'单乐',suggestion:'SL',needsReview:true,
    });
    await expect(service.bindDraftNumber(alternate,(await service.sources(designer,1,'DEVWLH2027P00-001')).items[0]!.sourceId,context(),randomUUID()))
      .rejects.toMatchObject({statusCode:404});
    await expect(service.saveOrderNumberSettings(f.root,{
      expectedVersion:before.version,...before.values,designers:[{userId:alternate.actorId,code:'LH'}],
    },randomUUID())).rejects.toThrow('已用于其他资料组合');
  });
});
