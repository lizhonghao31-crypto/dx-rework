import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {describe,it,expect,vi} from 'vitest';
import type {TodoResponse} from '@dx-rework/contracts';
import {TodoService} from '../../apps/api/src/todos/service.js';
import {todoSelectionKey} from '../../apps/api/src/todos/selection.js';
const actor={actorId:randomUUID(),actorRoles:['sample_designer'],authorizationCapability:'todo:view',authorizationCapabilities:['todo:view'],requestId:'TEST-read-split'};
const fixture=(index:number):TodoResponse=>{const id=randomUUID();return {todoId:id,sourceEventId:id,sourceAction:'digital_task',entityType:'digital_task',entityId:id,recipientUserId:actor.actorId,requiredRole:'sample_designer',requiredCapability:null,todoType:'business_action',category:'digital_task',taskTitle:`TEST ${index}`,route:{routeName:'digital_production_task',entityId:id,todoId:id},policyKey:null,dueAt:null,status:'pending',orderContext:null,reminderCount:0,blockedReason:null,version:1,createdAt:'2026-11-08T00:00:00.000Z',updatedAt:'2026-11-08T00:00:00.000Z',contentToken:'a'.repeat(64),unread:index%2===0};};
const db=()=>({query:vi.fn(async(sql:string)=>({rows:sql.includes('to_regclass')?[{relation:null}]:sql.includes('COUNT(*) pending_count')?[{pending_count:4}]:[]}))}) as unknown as Pool;
const provider=(rows:TodoResponse[])=>({todos:vi.fn(async()=>{throw Error('Full provider must not run');}),todoCounts:vi.fn(async()=>({totalCount:rows.length,pendingCount:rows.length,unreadCount:rows.filter(t=>t.unread).length})),todoSelections:vi.fn(async()=>rows.map(row=>({key:todoSelectionKey(row),load:vi.fn(async()=>row)}))),todo:vi.fn(async(_actor:unknown,id:string)=>rows.find(t=>t.todoId===id)??null)});
describe('separate todo count, page and single read',()=>{
 it('keeps production unread and digital active pending meanings without materializing either list',async()=>{
  const production=provider(Array.from({length:4},(_,i)=>fixture(i))),digital=provider(Array.from({length:5},(_,i)=>fixture(i)));production.todoCounts.mockResolvedValue({totalCount:4,pendingCount:2,unreadCount:2});
  const service=new TodoService(db(),undefined,undefined,production,digital);
  expect(await service.countIndicatorForActor(actor)).toEqual({pendingCount:11,unreadCount:5});
  for(const p of [production,digital]){expect(p.todoCounts).toHaveBeenCalledOnce();expect(p.todos).not.toHaveBeenCalled();expect(p.todoSelections).not.toHaveBeenCalled();}
 });
 it('hydrates only the requested15 and preserves complete module counts and final-page clamp',async()=>{
  const rows=Array.from({length:31},(_,i)=>fixture(i)),digital=provider(rows),production=provider([fixture(999)]),service=new TodoService(db(),undefined,undefined,production,digital);
  const page=await service.listForActor(actor,{module:'digital_production',page:2});
  expect(page).toMatchObject({page:2,totalCount:31,totalPages:3,moduleCounts:{digital_production:31,production:1}});expect(page.todos).toEqual(rows.slice(15,30));
  const selected=await digital.todoSelections.mock.results[0]!.value;
  expect(selected.filter(item=>item.load.mock.calls.length).map(item=>item.key.todoId)).toEqual(rows.slice(15,30).map(t=>t.todoId));
  const ignored=await production.todoSelections.mock.results[0]!.value;expect(ignored.every(item=>!item.load.mock.calls.length)).toBe(true);
  expect((await service.listForActor(actor,{module:'digital_production',page:999})).todos).toEqual(rows.slice(30));
 });
 it('batches rush facts for exact identities on the current authorized page only',async()=>{
  const orderContext={styleNo:'TEST same style',reworkNo:null,orderNo:null,supplierName:null,status:'ready',updatedAt:'2026-11-08T00:00:00.000Z'};
  const rows=Array.from({length:17},(_,i)=>({...fixture(i),orderContext:i===16?null:orderContext}));
  const sourceIds=rows.map(()=>randomUUID()), linkedOrder=randomUUID();
  const database=db(),query=vi.spyOn(database,'query');
  query.mockImplementation((async(sql:string)=>({rows:sql.includes('to_regclass')?[{relation:null,development:'documents'}]
   :sql.includes('WITH requested')?[{kind:'order',id:linkedOrder}]:[]})) as never);
  const digital={todos:async()=>[],todoSelections:async()=>rows.map((todo,i)=>({
   key:todoSelectionKey(todo),load:async()=>todo,rushIdentity:{sourceId:sourceIds[i]!,orderId:i===15?linkedOrder:null},
  }))};
  const result=await new TodoService(database,undefined,undefined,undefined,digital).listForActor(actor,{module:'digital_production',page:2});
  expect(result).toMatchObject({page:2,totalCount:17,totalPages:2});
  expect(result.todos).toEqual([{...rows[15],orderRush:true},rows[16]]);
  const facts=query.mock.calls.filter(call=>String(call[0]).includes('WITH requested'));
  expect(facts).toHaveLength(1);
  expect(facts[0]![1]).toEqual([[],[linkedOrder]]);
 });
 it('loads a target through single providers and returns404 after that target disappears',async()=>{
  const rows=[fixture(1),fixture(2)],digital=provider(rows),production=provider([]),service=new TodoService(db(),undefined,undefined,production,digital);
  expect(await service.getForActor(actor,rows[1]!.todoId)).toEqual(rows[1]);
  expect(digital.todo).toHaveBeenCalledWith(actor,rows[1]!.todoId);expect(digital.todos).not.toHaveBeenCalled();expect(production.todos).not.toHaveBeenCalled();
  digital.todo.mockResolvedValue(null);await expect(service.getForActor(actor,rows[1]!.todoId)).rejects.toMatchObject({statusCode:404});
 });
 it('searches lightweight keys and hydrates only actual SQL-selected provider results',async()=>{
  const rows=Array.from({length:31},(_,i)=>fixture(i)),digital=provider(rows),database=db(),query=vi.spyOn(database,'query');
  query.mockImplementation((async(sql:string)=>({rows:sql.includes('jsonb_array_elements')?[{total_count:31,total_pages:3,page:2,items:rows.slice(15,30).map(todo=>({kind:'provider',value:todoSelectionKey(todo)}))}]:sql.includes('to_regclass')?[{relation:null}]:[]})) as never);
  const result=await new TodoService(database,undefined,undefined,undefined,digital).listForActor(actor,{query:'TEST',page:2});expect(result.todos).toEqual(rows.slice(15,30));
  const selected=await digital.todoSelections.mock.results[0]!.value;expect(selected.filter(item=>item.load.mock.calls.length)).toHaveLength(15);
  const call=query.mock.calls.find(call=>String(call[0]).includes('jsonb_array_elements'))!;const input=JSON.parse((call[1] as string[])[2]!);expect(input).toHaveLength(31);expect(input[0]).not.toHaveProperty('timing');expect(input[0]).not.toHaveProperty('sourceEventId');
 });
});
