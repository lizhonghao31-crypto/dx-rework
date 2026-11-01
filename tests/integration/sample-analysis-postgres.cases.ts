import { ownedPostgresSchema, createOwnedPostgresSchema, dropOwnedPostgresSchema } from "../helpers/owned-postgres-schema.js";
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { afterAll,beforeAll,describe,expect,it } from 'vitest';
import { SampleAnalysisService } from '../../apps/api/src/samples/sample-analysis-service.js';
const url=process.env.TEST_DATABASE_URL??process.env.DATABASE_URL;
(url?describe:describe.skip)('sample analysis consistent SQL facts',()=>{
 const schema=ownedPostgresSchema("sample"),admin=new pg.Pool({connectionString:url!}),db=new pg.Pool({connectionString:url!,options:`-c search_path=${schema}`});
 const service=new SampleAnalysisService(db),person=randomUUID(),other=randomUUID(),brand=randomUUID(),department=randomUUID();
 const actor=(role='sample_finance')=>({actorId:person,actorRoles:[role],authorizationCapability:'sample:view_basic',authorizationCapabilities:['sample:view_basic','sample:view_finance'],requestId:'analysis-fixture'});
 const ids:string[]=[];
 async function sample(status:string,price:string,purchaser=person,rawBrand='品牌A'){
  const id=randomUUID(),isHeld=['borrowed','loss_payment_pending'].includes(status);
  await db.query(`INSERT INTO sample_items(sample_id,sample_code,status,brand,style_name,color,department,purchase_date,purchaser_user_id,purchaser_name,holder_user_id,holder_name,borrowed_at,created_by,archived_from_status,archived_reason,storage_location)
   VALUES($1::uuid,$1::text,$2,$3,'分析合成样衣','蓝','设计部','2026-09-01',$4,'同名人员',$5,$6,'2026-09-01',$7,$8,$9,$10)`,[id,status,rawBrand,purchaser,isHeld?purchaser:null,isHeld?'同名人员':null,person,status==='archived'?'borrowed':null,status==='archived'?'待分类':null,['in_stock','borrow_pending'].includes(status)?'合成测试库位':null]);
  await db.query('INSERT INTO sample_financial_facts(sample_id,purchase_price) VALUES($1,$2)',[id,price]);return id;
 }
 async function disposal(status:string,type:string,amount:string,approved:string,paid:string|null){
  const sampleId=await sample(status,'100.00'),request=randomUUID(),completed=status!=='loss_payment_pending';
  await db.query(`INSERT INTO sample_workflow_requests(request_id,sample_id,request_type,status,from_status,requested_by,resolved_by,resolved_at)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[request,sampleId,type,completed?'completed':'payment_pending',type==='sale'?'in_stock':'borrowed',person,completed?person:null,completed?approved:null]);
  await db.query(`INSERT INTO sample_disposals(disposal_id,request_id,sample_id,disposal_type,proposed_amount,final_amount,approved_by,approved_at,paid_by,paid_at,responsible_user_id)
   VALUES($1,$2,$3,$4,$5,$5,$6,$7,$8,$9,$6)`,[randomUUID(),request,sampleId,type,amount,person,approved,paid?person:null,paid]);
 }
 beforeAll(async()=>{
  await createOwnedPostgresSchema(admin,schema);
  for(const name of ['0001_platform_foundation.sql','0002_dingtalk_identity_access.sql','0003_identity_union_continuity.sql','0004_public_tools_foundation.sql','0005_access_master_data.sql','0152_sample_domain_foundation.sql','0153_sample_read_indexes_snapshots.sql','0157_sample_disposal_import.sql','0160_sample_analysis.sql'])await db.query(await readFile(new URL('../../apps/api/migrations/'+name,import.meta.url),'utf8'));
  for(const id of [person,other])await db.query("INSERT INTO app_users(id,display_name,enabled) VALUES($1,'同名人员',true)",[id]);
  for(let i=0;i<17;i++)ids.push(await sample('borrowed','0.10',i===16?other:person,i===16?'品牌Ａ':'品牌A'));
  const formal=await sample('archived','200.00'),excluded=await sample('archived','400.00');await sample('archived','300.00');
  for(const [id,type] of [[formal,'formal_history'],[excluded,'test_invalid']])await db.query("INSERT INTO sample_analysis_classifications(sample_id,version,classification,reason,recorded_by) VALUES($1,1,$2,'明确合成分类',$3)",[id,type,person]);
  for(const [id,kind,name] of [[brand,'brand','统一品牌'],[department,'department','设计部门']])await db.query('INSERT INTO sample_analysis_dimensions(dimension_id,kind,display_name,created_by) VALUES($1,$2,$3,$4)',[id,kind,name,person]);
  for(const raw of ['品牌A','品牌Ａ'])await db.query("INSERT INTO sample_analysis_aliases(kind,raw_name,version,dimension_id,reason,recorded_by) VALUES('brand',$1,1,$2,'明确合成别名',$3)",[raw,brand,person]);
  await db.query("INSERT INTO sample_analysis_aliases(kind,raw_name,version,dimension_id,reason,recorded_by) VALUES('department','设计部',1,$1,'明确合成别名',$2)",[department,person]);
  await db.query(`INSERT INTO sample_custody_records(custody_id,sample_id,holder_user_id,holder_name,department,purpose,borrowed_at,returned_at,requested_by,confirmed_by,initial_custody)
   VALUES($1,$2,$3,'同名人员','设计部','首次领用','2026-09-01','2026-09-02',$3,NULL,true),($4,$2,$3,'同名人员','设计部','再次借用','2026-09-03',NULL,$3,$3,false)`,[randomUUID(),ids[0],person,randomUUID()]);
  await disposal('sold','sale','10.00','2026-09-04T01:00:00Z',null);
  await disposal('lost','loss','7.00','2026-09-03T01:00:00Z','2026-09-04T01:00:00Z');
  await disposal('loss_payment_pending','loss','9.00','2026-09-04T01:00:00Z',null);
 });
 afterAll(async()=>{await db.end();await dropOwnedPostgresSchema(admin,schema);await admin.end();});
 it('aggregates all qualifying rows while paging only fifteen, preserving exact money and historical coverage',async()=>{
  const first=await service.read(actor(),{}),second=await service.read(actor(),{page:2});
  expect(first.totalCount).toBe(21);expect(first.items).toHaveLength(15);expect(second.items).toHaveLength(6);
  expect(new Set([...first.items,...second.items].map(r=>r.sampleId)).size).toBe(21);
  expect(first.summary).toMatchObject({purchaseCount:21,purchaseAmount:'501.70',legacyScopeAmount:'301.70',purchaserCount:2,heldCount:18,heldAmount:'101.70',initialCustodyCount:1,borrowCount:1,returnCount:1,saleReceipts:'10.00',confirmedLossCompensation:'7.00'});
  expect(first.coverage).toMatchObject({unclassifiedArchivedCount:1,excludedTestCount:1,formalArchivedCount:1,unmappedBrandCount:0});expect(first.archiveReview).toEqual({count:1,amount:'300.00'});
  expect(first.trend).toEqual([{month:'2026-09',count:21,amount:'501.70'}]);
  expect(first.groups).toHaveLength(2);expect(first.groups[0]?.person?.id).not.toBe(first.groups[1]?.person?.id);
  expect([...first.items,...second.items].find(r=>r.status==='archived')?.canOpenDetail).toBe(false);
 });
 it('uses explicit alias IDs without losing raw values and filters full sets before aggregating',async()=>{
  const r=await service.read(actor(),{brandId:brand,minPrice:'0.10',maxPrice:'0.10',group:'purchaser_brand',page:2});
  expect(r.summary.purchaseAmount).toBe('1.70');expect(r.totalCount).toBe(17);expect(r.items).toHaveLength(2);expect(r.groupTotal).toBe(2);
  expect((await service.read(actor(),{brandId:brand,group:'brand'})).groups).toHaveLength(1);
  const specific=await service.read(actor(),{purchaserUserId:other,holderUserId:other});expect(specific.totalCount).toBe(1);expect(specific.items[0]).toMatchObject({brand:'品牌Ａ',brandId:brand,brandName:'统一品牌',brandVersion:1});
  expect((await service.read(actor(),{brand:"' OR true --"})).totalCount).toBe(0);
 });
 it('separates purchase dates, approval dates and confirmed loss payment dates',async()=>{
  const r=await service.read(actor(),{eventFrom:'2026-09-04',eventTo:'2026-09-04'});
  expect(r.summary).toMatchObject({purchaseAmount:'501.70',disposalCount:2,saleReceipts:'10.00',confirmedLossCompensation:'7.00',borrowCount:0,returnCount:0});
  expect((await service.read(actor(),{purchaseFrom:'2026-09-02'})).summary.purchaseAmount).toBe('0.00');
 });
 it('protects classification history and restricts it to archived objects',async()=>{
  await expect(db.query("UPDATE sample_analysis_aliases SET reason='rewrite'")).rejects.toMatchObject({code:'55000'});
  await expect(db.query("INSERT INTO sample_analysis_classifications(sample_id,version,classification,reason,recorded_by) VALUES($1,1,'test_invalid','active sample',$2)",[ids[0],person])).rejects.toMatchObject({code:'23514'});
 });
 it('drills each custody, holding and receipt metric into the same qualifying sample set',async()=>{
  expect((await service.read(actor(),{fact:'held'})).totalCount).toBe(18);
  expect((await service.read(actor(),{fact:'return'})).items.map(r=>r.sampleId)).toEqual([ids[0]]);
  expect((await service.read(actor(),{fact:'initial_custody'})).totalCount).toBe(1);
  expect((await service.read(actor(),{fact:'sale',eventFrom:'2026-09-04',eventTo:'2026-09-04'})).summary).toMatchObject({purchaseCount:1,saleReceipts:'10.00'});
  expect((await service.read(actor(),{fact:'confirmed_loss',eventFrom:'2026-09-04',eventTo:'2026-09-04'})).summary).toMatchObject({purchaseCount:1,confirmedLossCompensation:'7.00'});
  expect((await service.read(actor(),{fact:'confirmed_loss',eventFrom:'2026-09-03',eventTo:'2026-09-03'})).totalCount).toBe(0);
  expect((await service.read(actor(),{fact:'disposal',disposalType:'loss'})).totalCount).toBe(2);
 });
 it('provides indexes for purchaser/date, category/date and price filters',async()=>{
  const client=await db.connect();try{await client.query('BEGIN');await client.query('SET LOCAL enable_seqscan=off');
   for(const [sql,index] of [[`SELECT sample_id FROM sample_items WHERE purchaser_user_id='${person}' AND purchase_date>='2026-09-01'`,'sample_analysis_purchaser_date_idx'],["SELECT sample_id FROM sample_items WHERE category='外套' AND purchase_date>='2026-09-01'",'sample_analysis_category_date_idx'],["SELECT sample_id FROM sample_financial_facts WHERE purchase_price BETWEEN 1 AND 2",'sample_analysis_price_idx']])expect(JSON.stringify((await client.query('EXPLAIN (COSTS OFF) '+sql)).rows)).toContain(index);
   await client.query('ROLLBACK');}finally{client.release();}
 });
 it('orders numeric amounts before group pagination and uses stable keys for ties',async()=>{
  const rankedPerson=randomUUID();await db.query("INSERT INTO app_users(id,display_name,enabled) VALUES($1,'排序合成人员',true)",[rankedPerson]);
  const values=[9,80,100,1000,1000,...Array.from({length:15},(_,i)=>10+i)];
  const expected=values.map((amount,i)=>({amount:amount.toFixed(2),key:'raw:Rank'+String(i).padStart(2,'0')}));
  for(const row of expected)await sample('in_stock',row.amount,rankedPerson,row.key.slice(4));
  expected.sort((a,b)=>Number(b.amount)-Number(a.amount)||a.key.localeCompare(b.key));
  const first=await service.read(actor(),{purchaserUserId:rankedPerson,group:'brand'});
  const second=await service.read(actor(),{purchaserUserId:rankedPerson,group:'brand',groupPage:2});
  expect(first.groupTotal).toBe(20);expect(first.groups).toHaveLength(15);expect(second.groups).toHaveLength(5);
  expect([...first.groups,...second.groups].map(({key,amount})=>({key,amount}))).toEqual(expected);
 });

});


