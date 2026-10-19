import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll,beforeAll,describe,it,expect } from 'vitest';
import type { TodoResponse } from '@dx-rework/contracts';
import { BUSINESS_TODO_CATEGORY_LABELS } from '@dx-rework/contracts/business-display';
import { todoCategoryTitles } from '@dx-rework/contracts';
import { globalTodoSearch } from '../../apps/api/src/todos/global-search.js';
import { ownedPostgresSchema } from '../helpers/owned-postgres-schema.js';
const url=process.env.TEST_DATABASE_URL??process.env.DATABASE_URL;
(url?describe:describe.skip)('global authorized todo SQL merge and pagination',()=>{
 const schema=ownedPostgresSchema('global_todo'),admin=new pg.Pool({connectionString:url!}),db=new pg.Pool({connectionString:url!,options:`-c search_path=${schema}`});
 const actorA=randomUUID(),actorB=randomUUID(),idsA:string[]=[],idsB:string[]=[];
 const captionIds=new Map<string,string>();
 const makeTodo=(recipient:string,index:number):TodoResponse=>{const todoId=randomUUID();return {todoId,todoType:'business_action',taskTitle:`MATCH 数字生产第${index}项`,category:'digital_task',sourceEventId:todoId,sourceAction:'digital_task',entityType:'digital_task',entityId:todoId,recipientUserId:recipient,requiredRole:null,requiredCapability:null,route:{routeName:'digital_production_task',entityId:todoId,todoId},policyKey:null,dueAt:null,reminderCount:0,status:'pending',blockedReason:null,orderContext:null,version:1,createdAt:'2026-10-17T00:00:00.000Z',updatedAt:'2026-10-17T00:00:00.000Z'};};
 const providers=[...Array.from({length:5},(_,i)=>({module:i%2?'production':'digital_production',todo:makeTodo(actorA,i)})),...Array.from({length:2},(_,i)=>({module:'digital_production',todo:makeTodo(actorB,i)}))];
 beforeAll(async()=>{
  await admin.query(`CREATE SCHEMA ${schema}`);
  await db.query(`CREATE TABLE fixture_todos(todo_id uuid PRIMARY KEY,recipient_user_id uuid,todo_type text,status text,category text,todo_module text,rework_status text,pattern_deleted_at timestamptz,style_no text,sourcing_style_no text,sample_style_no text,pattern_style_no text,supplier_name_snapshot text,sample_code text,pattern_order_no text,merchandiser_name text,rework_no text,order_no text,sourcing_order_no text,status_rank int,due_at timestamptz,created_at timestamptz)`);
  for(const [actor,count,ids] of [[actorA,31,idsA],[actorB,17,idsB]] as const)for(let i=0;i<count;i++){
   const id=randomUUID();ids.push(id);await db.query("INSERT INTO fixture_todos(todo_id,recipient_user_id,todo_type,status,category,todo_module,style_no,status_rank,created_at) VALUES($1,$2,'business_action','pending','ie_review',$3,'MATCH-STYLE',0,'2026-10-16T00:00:00Z')",[id,actor,['rework','sourcing','samples','pattern_room','suppliers'][i%5]]);
  }
  for(const kind of ['information','completed','deleted','pattern_deleted','wage_month_close'])await db.query("INSERT INTO fixture_todos(todo_id,recipient_user_id,todo_type,status,category,todo_module,rework_status,pattern_deleted_at,style_no,status_rank,created_at) VALUES($1,$2,$3,$4,$5,'rework',$6,$7,'MATCH-STYLE',0,'2026-10-16T00:00:00Z')",[randomUUID(),actorA,kind==='information'?'information':'business_action',kind==='completed'?'completed':'pending',kind==='wage_month_close'?kind:'ie_review',kind==='deleted'?'deleted':null,kind==='pattern_deleted'?'2026-10-17T00:00:00Z':null]);
  providers.push({module:'digital_production',todo:{...makeTodo(actorA,99),todoId:idsA[0]!}});
  for(const category of Object.keys(BUSINESS_TODO_CATEGORY_LABELS).filter(c=>!['ie_review','wage_month_close'].includes(c)))for(const recipient of [actorA,actorB]){
   const id=randomUUID();if(recipient===actorA)captionIds.set(category,id);
   await db.query("INSERT INTO fixture_todos(todo_id,recipient_user_id,todo_type,status,category,todo_module,style_no,status_rank,created_at) VALUES($1,$2,'business_action','pending',$3,'suppliers','CAPTION-ONLY',0,'2026-10-16T00:00:00Z')",[id,recipient,category]);
  }
  for(const recipient of [actorA,actorB])providers.push({module:'production',todo:{...makeTodo(recipient,200),category:'production_stale',taskTitle:undefined,daysWithoutUpdate:7}});

 },60000);
 afterAll(async()=>{await db.end();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();});
 it('merges every module, excludes other actors/inactive facts and returns only 15 per page',async()=>{
  const results=await Promise.all([1,2,3].map(page=>globalTodoSearch(db,'SELECT * FROM fixture_todos',actorA,'match',page,providers)));
  expect(results.map(r=>r.items.length)).toEqual([15,15,6]);expect(results.every(r=>r.total_count===36&&r.total_pages===3)).toBe(true);
  const all=results.flatMap(r=>r.items);expect(new Set(all.map(item=>item.kind==='database'?item.value.todo_id:item.value.todoId)).size).toBe(36);
  expect(all.every(item=>(item.value.recipient_user_id??item.value.recipientUserId)===actorA)).toBe(true);
  expect(new Set(all.filter(i=>i.kind==='database').map(i=>i.value.todo_module)).size).toBe(5);
  const other=await globalTodoSearch(db,'SELECT * FROM fixture_todos',actorB,'MATCH',1,providers);expect(other.total_count).toBe(19);
 });
 it('clamps pages, matches business titles, and binds untrusted query text',async()=>{
  expect(await globalTodoSearch(db,'SELECT * FROM fixture_todos',actorA,'MATCH',100000,providers)).toMatchObject({page:3,total_count:36});
  expect(await globalTodoSearch(db,'SELECT * FROM fixture_todos',actorA,'IE 审核',1,providers)).toMatchObject({total_count:31});
  expect(await globalTodoSearch(db,'SELECT * FROM fixture_todos',actorA,'数字生产第',1,providers)).toMatchObject({total_count:6});
  expect(await globalTodoSearch(db,'SELECT * FROM fixture_todos',actorA,"' OR TRUE --",1,providers)).toMatchObject({page:1,total_pages:0,total_count:0,items:[]});
 });
 it('finds existing supplier/card/notification captions and dynamic production text only for the recipient',async()=>{
  for(const [category,id] of captionIds){
   const result=await globalTodoSearch(db,'SELECT * FROM fixture_todos',actorA,BUSINESS_TODO_CATEGORY_LABELS[category]!,1,providers);
   expect(result.items.some(item=>item.value.todo_id===id),category).toBe(true);
   expect(result.items.every(item=>(item.value.recipient_user_id??item.value.recipientUserId)===actorA),category).toBe(true);
  }
  for(const caption of ['新增供应商审批','修改供应商申请']){
   const own=await globalTodoSearch(db,'SELECT * FROM fixture_todos',actorA,caption,1,providers);
   const other=await globalTodoSearch(db,'SELECT * FROM fixture_todos',actorB,caption,1,providers);
   expect(own.total_count).toBe(1);expect(other.total_count).toBe(1);
   expect(own.items[0]!.value.recipient_user_id).toBe(actorA);expect(other.items[0]!.value.recipient_user_id).toBe(actorB);
  }
  expect(await globalTodoSearch(db,'SELECT * FROM fixture_todos',actorA,todoCategoryTitles.ie_review!,1,providers)).toMatchObject({total_count:31});
  const stale=await globalTodoSearch(db,'SELECT * FROM fixture_todos',actorA,'已 7 天未更新',1,providers);
  expect(stale.total_count).toBe(1);expect(stale.items[0]!.value.recipientUserId).toBe(actorA);
 });

});
