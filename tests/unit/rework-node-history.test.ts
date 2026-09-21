import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { describe,it,expect,vi } from 'vitest';
import { canReadReworkHistoryNode, reworkHistoryNode } from '../../apps/api/src/rework/rework-node-history.js';
import type { TrustedActorContext } from '../../apps/api/src/tools/repositories.js';
import type { ReworkNodeHistory } from '@dx-rework/contracts/reporting';
vi.mock('../../apps/web/src/components.js',()=>({Header:()=>null,Shell:()=>null}));
import { ReworkNodeHistoryView } from '../../apps/web/src/rework-node-history-page.js';
const actor=(role:string,caps:string[]):TrustedActorContext=>({actorId:'00000000-0000-4000-8000-000000000001',actorRoles:[role],authorizationCapability:caps[0]??'',authorizationCapabilities:caps,requestId:'history-test'});
describe('rework historical node boundary',()=>{
 it('retains role and capability checks for process, quantity and responsibility records',()=>{
  expect(canReadReworkHistoryNode(actor('root_superuser',[]),'owner_signature')).toBe(true);
  expect(canReadReworkHistoryNode(actor('tail_supervisor',['process:configure']),'process_configuration')).toBe(true);
  expect(canReadReworkHistoryNode(actor('tail_supervisor',[]),'process_configuration')).toBe(false);
  expect(canReadReworkHistoryNode(actor('worker',['work:report']),'work_reporting')).toBe(true);
  expect(canReadReworkHistoryNode(actor('worker',['work:report']),'responsibility')).toBe(false);
  expect(canReadReworkHistoryNode(actor('factory_payables',['rework:finance_orders:read']),'owner_signature')).toBe(false);
  expect(canReadReworkHistoryNode(actor('finance_director',['rework:finance_nodes:read']),'owner_signature')).toBe(true);
 });
 it('keeps supplements and draft edits out of submitted initiation versions',()=>{
  expect(reworkHistoryNode('rework.submit')).toBe('initiation');
  expect(reworkHistoryNode('rework.attachments.supplement')).toBeNull();
  expect(reworkHistoryNode('rework.draft.update')).toBeNull();
  expect(reworkHistoryNode('rework.responsibility.owner_reject')).toBe('owner_signature');
  expect(reworkHistoryNode('rework.final_quantity.ie_review')).toBe('final_quantity_ie_review');
 });
 it('renders submitted forms and row facts without mutation controls',()=>{
  const entry={id:'00000000-0000-4000-8000-000000000002',label:'IE 核价',at:'2026-09-21T01:00:00Z',actor:'IE'};
  const data:ReworkNodeHistory={node:'ie_review',entry,versions:[entry],fields:[{label:'款号',value:'TEST-HISTORY'},{label:'审核意见',value:'已核对'}],sections:[{title:'工序与单价',columns:['工序','单价'],rows:[['修线','1.25']]}],attachments:[],notices:[],inspectionReport:null};
  const html=renderToStaticMarkup(createElement(ReworkNodeHistoryView,{data,currentHref:'/ui/tasks/test',onVersion:vi.fn(),onImage:vi.fn()}));
  expect(html).toContain('TEST-HISTORY');expect(html).toContain('1.25');expect(html.toLowerCase()).toContain('readonly=""');
  expect(html).toContain('返回当前节点');expect(html).not.toContain('<form');expect(html).not.toContain('type="submit"');expect(html).not.toContain('type="file"');
 });
});
