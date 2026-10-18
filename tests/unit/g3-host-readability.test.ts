import { describe,it,expect } from 'vitest';
import { businessExceptionLabel,businessExceptionDescription } from '../../packages/contracts/src/business-display.js';
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
  expect(businessExceptionDescription('待办逾期：unknown_private_category')).toBe('待办逾期：事项类别待核实');
  expect(businessExceptionDescription('扣款跟进逾期：TEST 某加工厂')).toBe('扣款跟进逾期：TEST 某加工厂');
 });
 it('preserves only original existing local drilldown paths',()=>{
  expect(exceptionRecordHref(`/ui/tasks/${id}`,'/acceptance/')).toBe(`/acceptance/ui/tasks/${id}`);
  expect(exceptionRecordHref(`/ui/external-responsibilities?case=${id}`,'/')).toBe(`/ui/external-responsibilities?case=${id}`);
  for(const path of [`https://example.test/ui/tasks/${id}`,`//example.test/ui/tasks/${id}`,`/ui/tasks/${id}/../${id}`,`/ui/tasks/${id}?returnTo=https://example.test`,'/ui/admin','/ui/tasks\\other'])expect(exceptionRecordHref(path,'/')).toBeNull();
 });
});
