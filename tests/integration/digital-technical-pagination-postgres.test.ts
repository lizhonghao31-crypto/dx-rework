import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {DigitalOrderCreateSchema,beijingCalendarDate} from '@dx-rework/contracts/digital-production';
import {DigitalProductionIdentityService} from '../../apps/api/src/production-platform/identity-service.js';
import {DigitalProductionTaskService} from '../../apps/api/src/production-platform/task-service.js';
import {readTaskAccessForPage,readTechnicalTaskListPage} from '../../apps/api/src/production-platform/journey-selection-access.js';
import {businessAnchorFixture} from '../helpers/business-anchor-fixture.js';

const url=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
(url?describe:describe.skip)('digital pagination PostgreSQL and native authorization',()=>{
 let f:Awaited<ReturnType<typeof businessAnchorFixture>>;
 beforeAll(async()=>{f=await businessAnchorFixture(url!);},75000);
 afterAll(async()=>{await f?.dispose();});

 it('selects eligible legacy source identities before total and target page',async()=>{
  const designer=f.people['sample-designer']!,service=new DigitalProductionIdentityService(f.db,true);
  const style='TEST-PAGE-SOURCE-'+randomUUID();
  const target=await service.createOrder(designer,DigitalOrderCreateSchema.parse({customerCode:'PD',productGroup:'男装',
    designStyleNo:style,orderDate:beijingCalendarDate(new Date()),primaryMerchandiserId:f.people.merchandiser!.actorId,
    lines:[{formalPoNo:style,color:'黑',customerWarehouseArrivalDate:'2027-03-01',sizes:[{size:'M',quantity:1}]}]}),randomUUID());
  // Historical identities predate the design-code registry. New creation
  // enforces uniqueness, but these old records can still be linked by ID.
  const ids=Array.from({length:31},()=>randomUUID());
  await f.db.query(`INSERT INTO digital_production_sources(source_id,created_by,development_type,design_style_no,
    temporary_style_no,customer_code,created_at)
    SELECT id,$2,'头版',$3,CASE WHEN position<=15 THEN 'legacy-other' END,'PD',
      now()-(CASE WHEN position<=15 THEN position ELSE 16 END)*interval '1 minute'
    FROM unnest($1::uuid[]) WITH ORDINALITY input(id,position)`,[ids,designer.actorId,style]);
  const eligible=ids.slice(15).sort().reverse();
  for(const [page,expected] of [[1,eligible.slice(0,15)],[2,eligible.slice(15)],[1,eligible.slice(0,15)],[3,[]]] as const){
   const result=await service.sources(designer,page,'',target.productionOrderId);
   expect(result.total).toBe(16);
   expect(result.items.map(row=>row.sourceId)).toEqual(expected);
  }
  await f.db.query('DELETE FROM digital_production_sources WHERE source_id=$1',[eligible[15]]);
  expect(await service.sources(designer,2,'',target.productionOrderId)).toEqual({items:[],page:2,total:15});
 });

 it('applies task read grants before LIMIT and does not mix snapshots during concurrent reassignment',async()=>{
  const warehouse=f.people.warehouse!,designer=f.people['sample-designer']!,service=new DigitalProductionIdentityService(f.db,true);
  const source=await service.createSource(designer,{developmentType:'头版',designStyleNo:'TEST-PAGE-TASK-'+randomUUID(),temporaryStyleNo:null,customerCode:'PD'},randomUUID());
  const ids=Array.from({length:31},()=>randomUUID());
  await f.db.query(`INSERT INTO digital_production_task_access(task_id,source_id,task_kind,required_role,assignee_id,created_by)
    SELECT id,$2,'development_material_supply',CASE WHEN position<=15 THEN 'sample_designer' ELSE 'warehouse_receiver' END,$3,$4
    FROM unnest($1::uuid[]) WITH ORDINALITY input(id,position)`,[ids,source.sourceId,warehouse.actorId,designer.actorId]);
  await f.db.query(`INSERT INTO digital_production_tasks(task_id,node_key,route_version,occurrence,route_instance_id,created_at)
    SELECT id,'development_material_supply',1,1,id,now()-(CASE WHEN position<=15 THEN position ELSE 16 END)*interval '1 minute'
    FROM unnest($1::uuid[]) WITH ORDINALITY input(id,position)`,[ids]);
  const eligible=ids.slice(15).sort().reverse();
  const tasks=new DigitalProductionTaskService(f.db);
  const first=await tasks.list(warehouse,1),second=await tasks.list(warehouse,2);
  expect(first.total).toBe(16);expect(second.total).toBe(16);
  expect(first.items.map(task=>task.taskId)).toEqual(eligible.slice(0,15));
  expect(second.items.map(task=>task.taskId)).toEqual(eligible.slice(15));
  const db=await f.db.connect();
  try{
   await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
   expect((await readTaskAccessForPage(db,warehouse,ids)).get(ids[0]!)?.technical).toBe(false);
   expect((await readTaskAccessForPage(db,warehouse,ids)).get(ids[15]!)?.technical).toBe(true);
   expect(await readTechnicalTaskListPage(db,warehouse,1)).toEqual({total:16,ids:eligible.slice(0,15)});
   await f.db.query('UPDATE digital_production_task_access SET assignee_id=NULL WHERE task_id=$1',[eligible[15]]);
   expect(await readTechnicalTaskListPage(db,warehouse,2)).toEqual({total:16,ids:eligible.slice(15)});
   expect(await readTechnicalTaskListPage(db,warehouse,3)).toEqual({total:16,ids:[]});
   await db.query('COMMIT');
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
  const latest=await f.db.connect();
  try{expect(await readTechnicalTaskListPage(latest,warehouse,2)).toEqual({total:15,ids:[]});}finally{latest.release();}
 });
});
