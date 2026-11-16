import {describe,expect,it,vi} from 'vitest';
import type {Pool} from 'pg';
import {hasFactoryPayablesReworkRead} from '@dx-rework/contracts/reporting';
import {canReadFactoryPayablesRework} from '../../apps/api/src/rework/finance-order-access.js';
import {canReadReworkHistoryNode} from '../../apps/api/src/rework/rework-node-history.js';
import {canOperateReworkNode} from '../../apps/web/src/rework-node-access.js';

const caps=['tools:user','rework:finance_orders:read','external_responsibility:payables_confirm'];
const actor={actorId:'factory',actorRoles:['factory_payables'],authorizationCapability:'rework:finance_orders:read',authorizationCapabilities:caps,requestId:'read-test'};
describe('factory payables rework-only read increment',()=>{
 it('opens the exact read identity and mixed role without making a generic capability a role',()=>{
  expect(hasFactoryPayablesReworkRead(actor.actorRoles,caps)).toBe(true);
  expect(hasFactoryPayablesReworkRead(['worker','factory_payables'],caps)).toBe(true);
  for(const roles of [undefined,[],['worker'],['fabric_payables'],['embroidery_washing_payables']])expect(hasFactoryPayablesReworkRead(roles,caps)).toBe(false);
  expect(hasFactoryPayablesReworkRead(actor.actorRoles,['tools:user'])).toBe(false);
 });
 it('rechecks the persisted direct role and refuses stale or forged claims',async()=>{
  const query=vi.fn().mockResolvedValueOnce({rows:[{permitted:true}]}).mockResolvedValueOnce({rows:[{permitted:false}]});
  const db={query} as unknown as Pool;
  expect(await canReadFactoryPayablesRework(db,actor)).toBe(true);
  expect(await canReadFactoryPayablesRework(db,actor)).toBe(false);
  expect(query).toHaveBeenCalledWith("SELECT external_responsibility_direct_role($1,$2,ARRAY['factory_payables']::text[]) permitted",['factory','rework:finance_orders:read']);
  expect(await canReadFactoryPayablesRework(db,{...actor,actorRoles:['fabric_payables']})).toBe(false);
  expect(query).toHaveBeenCalledTimes(2);
 });
 it('permits complete historical reading while node operations keep their own permissions',()=>{
  expect(canReadReworkHistoryNode(actor,'owner_signature')).toBe(true);
  expect(canReadReworkHistoryNode({...actor,actorRoles:['fabric_payables']},'owner_signature')).toBe(false);
  for(const node of ['process_configuration','ie_review','task_assignment','work_reporting','whole_order_review','responsibility','owner_signature'])expect(canOperateReworkNode(caps,node)).toBe(false);
 });
});
