import {afterEach,describe,expect,it,vi} from 'vitest';
import {FactoryDispatchSchema} from '@dx-rework/contracts/factory-flow';
import {factoryDispatchTime} from '../../apps/web/src/factory-dispatch-time-input.js';
describe('factory dispatch current/manual time contract',()=>{
 afterEach(()=>vi.useRealTimers());
 const form=(mode:string|null,value?:string)=>{const f=new FormData();if(mode!==null)f.set('dispatchTimeMode',mode);if(value!==undefined)f.set('at',value);return f;};
 it('current mode sends no browser timestamp even with an unrelated future wall clock or retained manual value',()=>{
  vi.useFakeTimers({toFake:['Date']});vi.setSystemTime('2099-01-01T00:00:00.000Z');
  expect(factoryDispatchTime(form('current','2000-01-01T00:00'))).toEqual({});
 });
 for(const [entered,expected] of [['2026-12-10T19:56:17.915','2026-12-10T11:56:17.915Z'],['2026-12-10T19:56:17','2026-12-10T11:56:17.000Z'],['2026-12-10T19:56','2026-12-10T11:56:00.000Z']])it(`manual ${entered} preserves its declared Beijing precision`,()=>{
  expect(factoryDispatchTime(form('manual',entered))).toEqual({occurredAt:expected});
 });
 it('missing/invalid mode and missing/invalid manual time are not silently converted to current',()=>{
  for(const f of [form(null),form('unknown'),form('manual'),form('manual','not-a-time')])expect(()=>factoryDispatchTime(f)).toThrow();
 });
 it('API permits omitted current time but retains null, invalid time and arbitrary clock override rejection',()=>{
  const base={expectedRevision:0,supplierId:'00000000-0000-4000-8000-000000000001'};
  expect(FactoryDispatchSchema.safeParse(base).success).toBe(true);
  for(const extra of [{occurredAt:null},{occurredAt:'not-a-time'},{businessNow:'2099-01-01T00:00:00Z'}])expect(FactoryDispatchSchema.safeParse({...base,...extra}).success).toBe(false);
 });
});
