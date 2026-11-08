import {describe,it,expect} from 'vitest';
import {digitalSlaDefaults} from '@dx-rework/contracts/digital-sla';
import {slaHistoryValueEqual,copiedHistoryValues,SlaHistoryQuerySchema,SlaCopyVersionSchema} from '@dx-rework/contracts/sla-settings-history';
describe('published history business comparison and copy',()=>{
 it('treats legacy omitted notifications as enabled while retaining actual threshold and disable changes',()=>{
  expect(slaHistoryValueEqual('warning_ratio',{kind:'ratio',percent:70},{kind:'ratio',percent:70,notificationEnabled:true})).toBe(true);
  expect(slaHistoryValueEqual('warning_ratio',{kind:'ratio',percent:70},{kind:'ratio',percent:70,notificationEnabled:false})).toBe(false);
  expect(slaHistoryValueEqual('ship_sample_advance',{kind:'offset',days:10},{kind:'offset',days:9})).toBe(false);
 });
 it('copies effective old values without creating a notification-only false change or mutating either standard',()=>{
  const historical=digitalSlaDefaults(),current=digitalSlaDefaults();current.warning_ratio={kind:'ratio',percent:70,notificationEnabled:true};historical.bulk_cutting={kind:'duration',minutes:120};const original=structuredClone(historical),copy=copiedHistoryValues(historical,current);
  expect(copy.warning_ratio).toEqual(current.warning_ratio);expect(copy.bulk_cutting).toEqual(historical.bulk_cutting);copy.bulk_cutting={kind:'duration',minutes:240};expect(historical).toEqual(original);expect(current.bulk_cutting).not.toEqual(copy.bulk_cutting);
 });
 it('bounds server paging and requires explicit source, current policy and personal draft revisions',()=>{
  expect(SlaHistoryQuerySchema.safeParse({pageSize:51}).success).toBe(false);expect(SlaHistoryQuerySchema.safeParse({beforeVersion:0}).success).toBe(false);expect(SlaCopyVersionSchema.safeParse({sourceVersion:1,expectedVersion:2,expectedDraftRevision:0}).success).toBe(true);expect(SlaCopyVersionSchema.safeParse({sourceVersion:1}).success).toBe(false);
 });
});
