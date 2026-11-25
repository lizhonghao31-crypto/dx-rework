import {describe,expect,it} from 'vitest';
import type {TodoResponse} from '@dx-rework/contracts';
import type {TrustedActorContext} from '../../apps/api/src/tools/repositories.js';
import {merchandiserWorkCandidate,merchandiserWorkPage} from '../../apps/api/src/production-platform/merchandiser-work-candidates.js';

const actor:TrustedActorContext={actorId:'test-merchandiser',actorRoles:['order_merchandiser','warehouse_receiver'],authorizationCapability:'todo:view',requestId:'test-workbench'};
const task={
 todoId:'test-handover',category:'digital_material_investment',requiredRole:'order_merchandiser',recipientUserId:actor.actorId,todoType:'business_action',status:'pending',
 taskTitle:'投面辅料',dueAt:'2026-11-25T09:00:00.000Z',route:{todoId:'test-handover',entityId:'test-source',routeName:'digital_source_material_investment'},
} satisfies Parameters<typeof merchandiserWorkCandidate>[1];
const route=(routeName:TodoResponse['route']['routeName'])=>({...task.route,routeName});
describe('only native actionable merchandiser work is eligible for the new workbench',()=>{
 it('retains the original pre-order source or formal order and the original deadline',()=>{
  expect(merchandiserWorkCandidate(actor,task)).toEqual({itemId:task.todoId,kind:'preparation',title:task.taskTitle,route:task.route,dueAt:task.dueAt});
  expect(merchandiserWorkCandidate(actor,{...task,route:{...route('digital_order_material_investment'),entityId:'test-order'}})?.route.entityId).toBe('test-order');
 });
 it('does not turn a second role, another recipient, a reminder or a superseded route into a new command',()=>{
  expect(merchandiserWorkCandidate(actor,{...task,requiredRole:'warehouse_receiver'})).toBeNull();
  expect(merchandiserWorkCandidate(actor,{...task,recipientUserId:'someone-else'})).toBeNull();
  expect(merchandiserWorkCandidate(actor,{...task,todoType:'information'})).toBeNull();
  expect(merchandiserWorkCandidate(actor,{...task,status:'blocked_recipient'})).toBeNull();
  expect(merchandiserWorkCandidate(actor,{...task,route:{...task.route,todoId:'stale'}})).toBeNull();
  expect(merchandiserWorkCandidate({...actor,actorRoles:['warehouse_receiver']},task)).toBeNull();
  expect(merchandiserWorkCandidate(actor,{...task,category:'digital_preparation_materials',route:route('digital_bulk_preparation')})).toBeNull();
 });
 it('permits only a current assigned craft follow-up identity for the original communication',()=>{
  const requiredRole='embroidery_washing_merchandiser';
  const craft={...task,requiredRole,category:'digital_task',taskTitle:'工艺沟通',route:{...route('digital_production_task'),entityId:task.todoId}};
  const actual={taskId:task.todoId,taskKind:'process_logistics',craftCommunication:{taskId:task.todoId,orderId:'exact-order',preparationId:'exact-route',stepRef:'exact-step'}};
  const assignee={...actor,actorRoles:[requiredRole]};
  expect(merchandiserWorkCandidate(assignee,craft,actual)).toMatchObject({kind:'delivery',craftCommunication:actual.craftCommunication});
  expect(merchandiserWorkCandidate(actor,craft,actual)).toBeNull();
  expect(merchandiserWorkCandidate(assignee,craft,{...actual,craftCommunication:{...actual.craftCommunication,taskId:'other'}})).toBeNull();
  expect(merchandiserWorkCandidate(assignee,task)).toBeNull();
 });
 it('preserves the exact contract-return route and does not turn an approval into a merchandiser action',()=>{
  const doc={documentId:'test-document',version:2,supplierName:'TEST factory',source:'price_reapplication' as const};
  const candidate={...task,category:'sourcing_contract_return',route:{...route('sourcing_detail'),tab:'contract_return' as const,contractReturn:doc}};
  expect(merchandiserWorkCandidate(actor,candidate)?.route).toEqual(candidate.route);
  expect(merchandiserWorkCandidate(actor,{...candidate,category:'sourcing_owner_approval'})).toBeNull();
  expect(merchandiserWorkCandidate(actor,{...candidate,route:route('sourcing_detail')})).toBeNull();
 });
 it('keeps transfer and price-application returns on their distinct original contract document versions',()=>{
  const transfer={documentId:'transfer-document',version:3,supplierName:'TEST next factory'};
  const price={documentId:'price-document',version:4,supplierName:'TEST price factory',source:'price_reapplication' as const};
  const transferRoute={...route('sourcing_detail'),tab:'contract_return' as const,transferContract:transfer};
  const priceRoute={...route('sourcing_detail'),tab:'contract_return' as const,contractReturn:price};
  expect(merchandiserWorkCandidate(actor,{...task,category:'sourcing_transfer_contract_return',route:transferRoute})?.route).toEqual(transferRoute);
  const storedWithoutTitle={...task,taskTitle:undefined};
  expect(merchandiserWorkCandidate(actor,{...storedWithoutTitle,category:'sourcing_transfer_contract_return',route:transferRoute})?.title).toBe('转厂合同回传');
  expect(merchandiserWorkCandidate(actor,{...task,category:'sourcing_price_contract_return',route:priceRoute})?.route).toEqual(priceRoute);
  expect(merchandiserWorkCandidate(actor,{...task,category:'sourcing_price_contract_return',route:transferRoute})).toBeNull();
  expect(merchandiserWorkCandidate(actor,{...task,category:'sourcing_transfer_contract_return',route:priceRoute})).toBeNull();
 });
 it('filters the authorized set first and uses urgency, real due and stable original IDs before paging',()=>{
  const projected=merchandiserWorkCandidate(actor,task)!;
  const rows=Array.from({length:32},(_,index)=>({...projected,itemId:`task-${String(index).padStart(2,'0')}`,
   urgent:index===31,state:'mine' as const,orderNumber:'TEST same order',styleNo:null,poNumbers:[index<16?'different':'TARGET'],
   customer:'TEST',factory:'TEST factory'}));
  const first=merchandiserWorkPage(rows,{state:'mine',search:'target',page:1});
  expect(first).toMatchObject({page:1,total:16});expect(first.items).toHaveLength(15);
  expect(first.items[0]?.itemId).toBe('task-31');
  const second=merchandiserWorkPage([...rows].reverse(),{state:'mine',search:'target',page:2});
  expect(second.items.map(row=>row.itemId)).toEqual(['task-30']);
  expect(new Set([...first.items,...second.items].map(row=>row.itemId)).size).toBe(16);
  expect(merchandiserWorkPage(rows,{state:'waiting',search:'target',page:1})).toEqual({items:[],page:1,total:0});
 });
});
