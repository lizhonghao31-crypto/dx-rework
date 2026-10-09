import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { describe,it,expect,vi } from 'vitest';
import { canReadReworkHistoryNode, reworkHistoryNode, selectReworkInitiationSnapshot } from '../../apps/api/src/rework/rework-node-history.js';
import type { TrustedActorContext } from '../../apps/api/src/tools/repositories.js';
import type { ReworkNodeHistory } from '@dx-rework/contracts/reporting';
vi.mock('../../apps/web/src/components.js',()=>({Header:()=>null,Shell:()=>null}));
import { WholeOrderReviewPanel } from '../../apps/web/src/whole-order-review-panel.js';
import type { WholeOrderReviewResponse } from '@dx-rework/contracts';
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
 it('preserves complete submitted fields when later node audits contain only partial order facts',()=>{
  const submission={styleNo:'HISTORY',orderQuantity:1000,reworkReason:'断线',reworkProcess:'修线',tailInspectionCostBearer:'processing_factory',inspectionReport:{styleName:'历史验货报告'}};
  expect(selectReworkInitiationSnapshot([
   {action:'rework.draft.create',after:{...submission,orderQuantity:900}},
   {action:'rework.submit',after:submission},
   {action:'rework.process_configuration.review',after:{styleNo:'HISTORY',reworkQuantity:200}},
  ])).toEqual(submission);
  expect(selectReworkInitiationSnapshot([
   {action:'rework.submit',after:submission},
   {action:'rework.draft.update',after:{...submission,reworkReason:null}},
   {action:'rework.work_report.submit',after:{styleNo:'HISTORY'}},
  ]).reworkReason).toBeNull();
  expect(selectReworkInitiationSnapshot([{action:'rework.work_report.submit',after:{styleNo:'HISTORY'}}])).toEqual({});
 });
 it('keeps supplements and draft edits out of submitted initiation versions',()=>{
  expect(reworkHistoryNode('rework.submit')).toBe('initiation');
  expect(reworkHistoryNode('rework.finishing.submit')).toBe('initiation');
  expect(reworkHistoryNode('rework.attachments.supplement')).toBeNull();
  expect(reworkHistoryNode('rework.draft.update')).toBeNull();
  expect(reworkHistoryNode('rework.responsibility.owner_reject')).toBe('owner_signature');
  expect(reworkHistoryNode('rework.final_quantity.ie_review')).toBe('final_quantity_ie_review');
 });
 it('renders finishing as six historical nodes with its source fields',()=>{
  const id='00000000-0000-4000-8000-000000000002',entry={id,label:'本厂做尾',at:'2026-10-01T00:00:00Z',actor:'尾部主管'};
  const data:ReworkNodeHistory={reworkKind:'inhouse_finishing',orderId:id,node:'initiation',entry,versions:[entry],fields:[{label:'款号',value:'TEST-FINISHING'},{label:'加工厂',value:'历史加工厂'},{label:'订单数量',value:'100'}],sections:[],attachments:[],notices:[],inspectionReport:null};
  const html=renderToStaticMarkup(createElement(ReworkNodeHistoryView,{data,currentHref:'/ui/tasks/test',onVersion:vi.fn(),onImage:vi.fn()}));
  expect(html).toContain('本厂做尾来源资料');expect(html).toContain('历史加工厂');
  expect(html.match(/rework-workflow-step /g)).toHaveLength(12); // Desktop and mobile each have six nodes.
  for(const label of ['质检','责任判定','老板确认签字','发起返工'])expect(html).not.toContain(label);
  expect(html).not.toContain('type="file"');
 });
 it('renders the original allocation page with submitted workers and no enabled mutation controls',()=>{
  const id='00000000-0000-4000-8000-000000000002';
  const entry={id,label:'分配工序与工人',at:'2026-09-21T01:00:00Z',actor:'尾部主管'};
  const data:ReworkNodeHistory={orderId:id,node:'process_configuration',entry,versions:[entry],fields:[{label:'款号',value:'TEST-HISTORY'}],sections:[],attachments:[],notices:[],inspectionReport:null,page:{iePrecounts:{entries:[]},tailInspection:null,workTasks:null,wholeOrderReview:null,responsibility:null,
   configuration:{reworkOrderId:id,reworkNo:'RW-TEST',reworkStatus:'pending_ie_review',orderVersion:3,tailInspectionRequired:false,configuration:{configurationId:id,configurationVersion:1,kind:'initial',status:'pending_ie_review',changeReason:null,reviewReason:null,createdAt:entry.at,submittedAt:entry.at,reviewedAt:null,unifiedExecutionRequired:true,items:[{configurationItemId:id,source:'custom',processId:null,processVersion:null,processName:'修线',executionKind:'worker',pricingUnit:'piece',plannedQuantity:100,unitPrice:1.25,promotedProcessId:null}]}},
   workerPlan:{reworkOrderId:id,reworkStatus:'pending_ie_review',orderVersion:3,required:true,configurationId:id,configurationVersion:1,configurationStatus:'pending_ie_review',complete:true,assignments:[{configurationItemId:id,processName:'修线',executionKind:'worker',members:[{personId:id,displayName:'张师傅',personType:'internal'}]}]}
  }};
  const html=renderToStaticMarkup(createElement(ReworkNodeHistoryView,{data,currentHref:'/ui/tasks/test',onVersion:vi.fn(),onImage:vi.fn()}));
  expect(html).toContain('process-worker-line');
  expect(html).toContain('张师傅');expect(html).toContain('1.25');
  expect(html).toContain('返回当前节点');expect(html).toContain('电脑端流程节点');
  expect(html).not.toContain('保存工序&amp;工人');expect(html).not.toContain('提交 IE 核价');
  expect(html).not.toContain('rework-history-fields');expect(html).not.toContain('type="file"');
 });
 it('retains the original IE conditional price review and disables submission',()=>{
  const id='00000000-0000-4000-8000-000000000002';
  const data:WholeOrderReviewResponse={reworkOrderId:id,reworkStatus:'pending_final_quantity_ie_review',orderVersion:5,canReview:false,canIeReview:false,canAdjustQuantity:false,canConfirmQuantity:false,canReviewQuantityIncrease:false,unifiedExecutionRequired:true,tailInspectionRequired:false,
   processes:[{configurationItemId:id,processName:'修线',pricingUnit:'piece',plannedQuantity:100,originalCompletedQuantity:100,completedQuantity:100,originalTailCheckedQuantity:0,tailCheckedQuantity:0,countGap:0,complete:true,finalUnitPrice:12}],reports:[],temporaryWorkers:[],adjustments:[],reviewId:null,
   finalConfirmation:{confirmationId:id,confirmationVersion:1,status:'approved',confirmedBy:id,confirmedAt:'2026-09-21T01:00:00Z',reviewedBy:id,reviewedAt:'2026-09-21T02:00:00Z',reviewReason:null,prices:[{configurationItemId:id,originalUnitPrice:12,proposedUnitPrice:12,changed:false}],quantities:[{configurationItemId:id,workerReportedQuantity:100,tailReportedQuantity:0,finalConfirmedQuantity:100,changed:false}]}};
  const render=()=>renderToStaticMarkup(createElement(WholeOrderReviewPanel,{reworkOrderId:id,onChanged:async()=>{},embedded:true,history:{data,node:'final_quantity_ie_review'}}));
  expect(render()).not.toContain('价格复核');expect(render()).not.toContain('IE 复核通过');
  data.finalConfirmation!.prices[0]={configurationItemId:id,originalUnitPrice:12,proposedUnitPrice:12.345,changed:true};
  const changed=render();expect(changed).toContain('价格复核');expect(changed).toContain('¥12.35');expect(changed).not.toContain('12.345');
 });
});
