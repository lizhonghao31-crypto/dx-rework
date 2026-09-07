import {describe,expect,it} from 'vitest';
import type {ProductionDashboardItem} from '@dx-rework/contracts';
import {canAnimateProductionProgress,relativeProductionTime} from '../../apps/web/src/production-dashboard-model.js';
const item={order:{status:'in_production'},progress:{frozen:false,firstReportedOn:'2026-09-01',productionProgress:65,progressState:'normal'}} as ProductionDashboardItem;
describe('production motion preserves recorded state',()=>{
 it('animates only reported ongoing production while motion is allowed',()=>{
  expect(canAnimateProductionProgress(item,true)).toBe(true);
  expect(canAnimateProductionProgress(item,false)).toBe(false);
  for(const state of ['stale','pending_first_report','completed'] as const)expect(canAnimateProductionProgress({...item,progress:{...item.progress,progressState:state}},true)).toBe(false);
  for(const status of ['production_completed','shipped'] as const)expect(canAnimateProductionProgress({...item,order:{...item.order,status}},true)).toBe(false);
  expect(canAnimateProductionProgress({...item,progress:{...item.progress,frozen:true}},true)).toBe(false);
  expect(canAnimateProductionProgress({...item,progress:{...item.progress,firstReportedOn:null}},true)).toBe(false);
  expect(canAnimateProductionProgress({...item,progress:{...item.progress,productionProgress:0}},true)).toBe(false);
 });
 it('reports elapsed minutes from the supplied timestamp without advancing business data',()=>{
  const source='2026-09-07T00:00:00Z',start=Date.parse(source);
  expect(relativeProductionTime(source,start-60000)).toBe('不到1分钟');
  expect(relativeProductionTime(source,start+59*60000)).toBe('59分钟');
  expect(relativeProductionTime(source,start+135*60000)).toBe('2小时15分钟');
  expect(relativeProductionTime(source,start+3*86400000)).toBe('3天');
 });
});
