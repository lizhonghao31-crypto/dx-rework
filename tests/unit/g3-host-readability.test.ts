import { describe,it,expect } from 'vitest';
import { BUSINESS_TODO_CATEGORY_LABELS,businessExceptionLabel,businessExceptionDescription } from '../../packages/contracts/src/business-display.js';
import { todoCategoryTitles } from '../../packages/contracts/src/todo-presentation.js';
import { uniqueJourneyEntries,journeyDocumentGroups } from '../../apps/web/src/digital-journey-cockpit-model.js';
import type { JourneyRecord,OrderJourney } from '@dx-rework/contracts/digital-production-journey';
import { exceptionRecordHref } from '../../apps/web/src/reporting/exception-presentation.js';
const id='00000000-0000-4000-8000-000000000001';
const record:JourneyRecord={domain:'development',id,url:`/ui/digital-production?development=${id}&round=2`,version:2,lineId:null,mode:'read'};
describe('host readability preserves existing identities',()=>{
 it('deduplicates identical destinations while retaining versions, lines and action modes',()=>{
  const entries=[record,{...record,id:'another-id'},{...record,version:1},{...record,lineId:id},{...record,mode:'handle' as const},{...record,url:record.url+'&version=3',version:3}].map((record,index)=>({key:String(index),record}));
  expect(uniqueJourneyEntries(entries)).toHaveLength(5);
  const order={stages:[{nodes:[{records:[record],round:2,subject:'TEST 开发',label:'开发',occurrence:1}]}],links:[{...record,id:'other'}],lines:[]} as unknown as OrderJourney;
  expect(journeyDocumentGroups(order).flatMap(group=>group.entries)).toHaveLength(1);
 });
 it('uses business exception captions and makes unmapped categories explicit',()=>{
  expect(businessExceptionLabel('overdue_todo')).toBe('待办逾期');
  expect(businessExceptionDescription('待办逾期：sourcing_finance_reconcile')).toBe('待办逾期：财务核对');
  expect(businessExceptionDescription('接收人失效：process_configuration_return')).toBe('接收人失效：退回重新配置工序');
  expect(businessExceptionDescription('待办逾期：final_quantity_ie_review')).toBe('待办逾期：IE 复核最终数量');
  expect(businessExceptionDescription('钉钉投递永久失败：external_deduction_follow_up')).toBe('钉钉投递永久失败：跟进供应商实际扣款');
  for(const category of Object.keys(todoCategoryTitles)) expect(BUSINESS_TODO_CATEGORY_LABELS[category],category).toBeTruthy();
  expect(businessExceptionDescription('待办逾期：unknown_private_category')).toBe('待办逾期：事项类别待核实');
  expect(businessExceptionDescription('扣款跟进逾期：TEST 某加工厂')).toBe('扣款跟进逾期：TEST 某加工厂');
 });
 it('preserves only original existing local drilldown paths',()=>{
  expect(exceptionRecordHref(`/ui/tasks/${id}`,'/acceptance/')).toBe(`/acceptance/ui/tasks/${id}`);
  const focused=`/ui/tasks/${id}?node=settlement_followup&case=${id}`;
  expect(exceptionRecordHref(focused,'/acceptance/')).toBe(`/acceptance${focused}`);
  for(const path of [`/ui/external-responsibilities?case=${id}`,`${focused}&case=${id}`,`${focused}&returnTo=https://example.test`,focused.replace('settlement_followup','responsibility'),`https://example.test/ui/tasks/${id}`,`//example.test/ui/tasks/${id}`,`/ui/tasks/${id}/../${id}`,`/ui/tasks/${id}?returnTo=https://example.test`,'/ui/admin','/ui/tasks\\other'])expect(exceptionRecordHref(path,'/')).toBeNull();
 });
});
