import {describe,it,expect} from 'vitest';
import {deliverySummary,deliveryPo} from '@dx-rework/domain/delivery-calendar';
import type {DeliveryPoFact} from '@dx-rework/contracts/delivery-calendar';
import {cockpitReturnPath} from '../../apps/web/src/digital-journey-cockpit-model.js';
import {readDeliveryPageState,deliveryPagePath,deliveryReturnPath,deliveryApiQuery,deliveryMonthCells,shiftDeliveryMonth,deliveryPercentages} from '../../apps/web/src/delivery-calendar-model.js';
const today='2026-11-08';
describe('delivery calendar navigation and read boundaries',()=>{
 it('round-trips current view/day/filters/page and side group without storing stale snapshots',()=>{
  const state=readDeliveryPageState('?workspace=delivery&view=day&date=2026-11-20&search=PO%20A&customer=C1&status=pending&group=before-selected&page=2',today),path=deliveryPagePath(state);
  expect(readDeliveryPageState(path.split('?')[1]!,today)).toEqual(state);expect(deliveryReturnPath(path,'/acceptance/')).toBe(path);expect(deliveryReturnPath('/acceptance'+path,'/acceptance/')).toBe(path);expect(path).not.toContain('snapshotId');
  const api=new URL(deliveryApiQuery(state,'day',{snapshotId:'test-snapshot',page:1}),'https://local.invalid');expect(api.pathname).toBe('/delivery-calendar/day');expect(Object.fromEntries(api.searchParams)).toMatchObject({date:'2026-11-20',group:'before-selected',page:'1',pageSize:'15',snapshotId:'test-snapshot',search:'PO A',customer:'C1'});
 });
 it('rejects invalid and duplicate queries and external or unapproved return destinations',()=>{
  for(const query of ['?date=2026-02-30','?date=2026-11-08&page=0','?date=2026-11-08&date=2026-11-09','?workspace=factory','?date=2026-11-08&snapshotId=opaque'])expect(()=>readDeliveryPageState(query,today)).toThrow();
  for(const path of ['https://foreign.invalid/ui/digital-cockpit?workspace=delivery','//foreign.invalid','/ui/digital-cockpit?workspace=settings','/ui/digital-cockpit?workspace=delivery&date=2026-02-30','/ui/digital-cockpit?workspace=delivery#wrong','/ui/digital-cockpit?workspace=delivery&selected=other'])expect(deliveryReturnPath(path)).toBeNull();
 });
 it('preserves a validated calendar reading context through original nested-order returns without allowing external destinations',()=>{const calendar=deliveryPagePath(readDeliveryPageState('?view=month&date=2026-11-18&page=2&customer=C1',today)),order='/ui/digital-cockpit?selected=00000000-0000-4000-8000-000000000001&'+new URLSearchParams({deliveryReturn:calendar}),back=cockpitReturnPath('?'+new URLSearchParams({returnTo:order}));expect(back).not.toBeNull();expect(new URL(back!,'https://local.invalid').searchParams.get('deliveryReturn')).toBe(calendar);expect(cockpitReturnPath('?'+new URLSearchParams({returnTo:order.replace(encodeURIComponent(calendar),encodeURIComponent('https://foreign.invalid'))}))).toBeNull();});
 it('generates real Monday-first four/five/six-week months including leap day and Sunday endings',()=>{
  expect(deliveryMonthCells('2021-02')).toHaveLength(28);expect(deliveryMonthCells('2026-11')).toHaveLength(42);expect(deliveryMonthCells('2028-02')).toHaveLength(35);expect(deliveryMonthCells('2028-02')).toContain('2028-02-29');expect(deliveryMonthCells('2026-11').slice(0,7)).toEqual([null,null,null,null,null,null,'2026-11-01']);expect(deliveryMonthCells('2026-03').at(-1)).toBeNull();expect(()=>deliveryMonthCells('2026-13')).toThrow();
 });
 it('moves periods across years using a deliberate first-of-month view selection',()=>{expect(shiftDeliveryMonth('2026-12-31',1)).toBe('2027-01-01');expect(shiftDeliveryMonth('2026-01-31',-1)).toBe('2025-12-01');expect(()=>shiftDeliveryMonth('2199-12-31',1)).toThrow();});
 it('requests a year or month without preload of daily PO data and keeps missing-period context explicit',()=>{
  const state=readDeliveryPageState('?view=year&date=2026-11-18',today),year=new URL(deliveryApiQuery(state,'year'),'https://local.invalid');expect(year.searchParams.get('year')).toBe('2026');expect(year.searchParams.has('page')).toBe(false);expect(year.searchParams.has('date')).toBe(false);
  expect(new URL(deliveryApiQuery({...state,view:'missing',backView:'year'},'missing'),'https://local.invalid').searchParams.get('year')).toBe('2026');expect(new URL(deliveryApiQuery({...state,view:'missing',backView:'month'},'missing'),'https://local.invalid').searchParams.get('month')).toBe('2026-11');
  const month=new URL(deliveryApiQuery({...state,view:'month'},'month'),'https://local.invalid');expect(Object.fromEntries(month.searchParams)).toMatchObject({month:'2026-11',selectedDate:'2026-11-18',page:'1',pageSize:'15'});expect(new URL(deliveryApiQuery({...state,view:'missing',allMissing:'1'},'missing'),'https://local.invalid').searchParams.has('year')).toBe(false);expect(new URL(deliveryApiQuery({...state,view:'missing',allMissing:'1'},'missing'),'https://local.invalid').searchParams.has('month')).toBe(false);
 });
 it('never makes rounded delivery shares add to101 or fills unknown quantities with zero',()=>{
  const fact:DeliveryPoFact={orderId:'test-order',lineId:'test-po',businessOrderNo:null,designStyleNo:'TEST',po:'PO-A',color:'蓝',customer:'C',productType:null,orderedQty:320,rawPackedQty:120,packingRevision:'native',effectiveDueDate:'2026-11-18',originalDueDate:null,factoryDueDate:null,dueRevision:1,dueHistoryRef:null,hasRecordedDueChange:false,reminderDays:7,scopeStatus:'active',sourceRefs:[],unknownReasons:[]};
  expect(deliveryPercentages(deliverySummary([deliveryPo(fact,today)]))).toEqual({packed:38,pending:62});expect(deliveryPercentages(deliverySummary([deliveryPo({...fact,rawPackedQty:null},today)]))).toBeNull();expect(deliveryPercentages(deliverySummary([]))).toEqual({packed:0,pending:0});
 });
});
