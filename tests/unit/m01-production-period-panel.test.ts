// @vitest-environment jsdom
import {act,createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {describe,it,expect,vi} from 'vitest';
import {ProductionPeriodPanel,ProductionPeriodComparisonTable,ProductionPeriodCycleTable} from '../../apps/web/src/production-period-panel.js';
import {productionPeriodProjection} from '../../apps/api/src/production-platform/production-period-projection.js';
import {productionPeriodSheets} from '../../apps/api/src/production-platform/production-period-export.js';
import type {ProductionPeriodAnalysis,ProductionPeriodEvent} from '@dx-rework/contracts/production-period';
const event=(id:string,date:string,quantity:number,kind='packed'):ProductionPeriodEvent=>({id,rootId:id,revision:1,orderId:'TEST-mother',lineId:id,kind,quantity,unit:'件',occurred:{date,at:null,precision:'date',quality:'verified',sourceRefs:['TEST actual occurrence']},recordedAt:'2027-01-02T00:00:00Z',effective:true,factoryId:null,factoryScopeVersion:null,sourceRefs:['TEST original saved event']});
const project=(events:ProductionPeriodEvent[])=>productionPeriodProjection({events,promises:[],completions:[],limitations:[]},{from:'2026-12-01',to:'2026-12-31',compareFrom:'2026-11-01',compareTo:'2026-11-30',customer:'',category:'',page:1,view:'production',timeMode:'output'},events.map(e=>({orderId:e.orderId,lineId:e.lineId!})),'2027-01-03T00:00:00Z');
describe('R2-05 compact period comparison and original-period drills',()=>{
 it('R2-05 Review: the fully consumed comparison month displays its exclusive Beijing end and exports matching elapsed-day coverage',async()=>{
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);const host=document.createElement('div');document.body.append(host);const root=createRoot(host),events=[event('CURRENT','2026-12-20',10),event('BASELINE','2026-11-20',10)],data=productionPeriodProjection({events,promises:[],completions:[],limitations:[]},{from:'2026-12-01',to:'2026-12-31',compareFrom:'2026-11-01',compareTo:'2026-11-30',compareElapsed:true,customer:'',category:'',page:1,view:'production',timeMode:'output'},events.map(e=>({orderId:e.orderId,lineId:e.lineId!})),'2026-12-31T12:00:00+08:00');
  try{await act(async()=>root.render(createElement(ProductionPeriodPanel,{data,openPo:vi.fn(),taskHref:(id:string)=>'/task/'+id,orderHref:(id:string)=>'/order/'+id})));const boundary=host.querySelector('section>p')!.textContent!;expect(boundary).toContain('本期截止 2026/12/31 00:00:00');expect(boundary).toContain('对比期截止 2026/12/01 00:00:00');expect(boundary).not.toContain('对比期截止 2026/12/31');const sheet=productionPeriodSheets(data).find(s=>s.name==='期间口径与比较')!;expect(sheet.rows.some(row=>row[0]==='原装箱出货'&&row[6]===30&&row[7]===30)).toBe(true);}finally{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();}
 });
 it('keeps actual elapsed node windows, partial waiting coverage and unfinished age separate from personal net working time',async()=>{
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);const host=document.createElement('div');document.body.append(host);const root=createRoot(host),data=project([]);
  const make=(id:string,seconds:number):ProductionPeriodAnalysis['cycles']['completed'][number]=>({window:{id,orderId:'TEST-mother',lineIds:[],nodeKey:'TEST-pattern',label:'TEST原纸样',version:'TEST-v1',state:'completed',assigneeId:null,independent:true,excludedReason:null,entered:{at:'2026-12-01T00:00:00Z',date:null,precision:'instant',quality:'verified',sourceRefs:[]},completed:{at:'2026-12-02T00:00:00Z',date:null,precision:'instant',quality:'verified',sourceRefs:[]},deadline:null,deadlineExclusive:false,waits:[],waitingCoverage:'partial',sourceRefs:[]},due:null,onTime:null,completedSeconds:seconds,unfinishedAgeSeconds:null,knownWaitingSeconds:7200,waitingCoverage:'partial',unknown:[]});
  data.cycles.completed=[make('A',8*3600),make('B',16*3600)];data.cycles.currentUnfinished=[{...make('C',0),completedSeconds:null,unfinishedAgeSeconds:3*3600}];
  try{await act(async()=>root.render(createElement(ProductionPeriodCycleTable,{data,taskHref:id=>'/task/'+id})));expect(host.textContent).toContain('12小时');expect(host.textContent).toContain('16小时');expect(host.textContent).toContain('不等于人员净工时');await act(async()=>host.querySelector<HTMLButtonElement>('tbody button')!.click());const drill=host.querySelector('[aria-label="节点经过时间明细"]')!;expect([...drill.querySelectorAll('a')].map(e=>e.getAttribute('href'))).toEqual(['/task/A','/task/B']);expect(drill.textContent).toContain('覆盖不全');expect(drill.textContent).not.toContain('3小时');}finally{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();}
 });
 it('does not label an unknown comparison as a zero baseline or show a complete count difference for an unknown due queue',async()=>{
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);const host=document.createElement('div');document.body.append(host);const root=createRoot(host),data=project([{...event('UNKNOWN','2026-12-05',1),quantity:null}]);
  data.due.customer.unknown.push({scopeId:'TEST-unknown-window',reason:'TEST missing original obligation'});
  try{await act(async()=>root.render(createElement(ProductionPeriodComparisonTable,{data,openPo:()=>{},taskHref:id=>'/task/'+id})));const table=host.querySelector('table')!;expect(table.textContent).toContain('可比值待核');expect(table.textContent).not.toContain('基期为0');expect(table.textContent).toContain('应完成/按期数差待核');}finally{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();}
 });
 it('shows current, baseline and difference directly and drills each period original saved event set with equal export IDs',async()=>{
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);const host=document.createElement('div');document.body.append(host);const root=createRoot(host),openPo=vi.fn(),props={openPo,taskHref:(id:string)=>'/task/'+id};
  try{
   const data=project([event('CURRENT','2026-12-05',10),event('BASELINE','2026-11-05',4),event('ADDED','2026-12-06',2,'factory-produced')]);
   await act(async()=>root.render(createElement(ProductionPeriodComparisonTable,{...props,data})));
   const table=host.querySelector('table')!;expect([...table.querySelectorAll('thead th')].map(e=>e.textContent)).toEqual(['指标','本期','对比期','差额']);expect(table.closest('details')).toBeNull();expect(table.textContent).toContain('6件');expect(table.textContent).toContain('150%');expect(table.textContent).toContain('由0新增');expect(table.textContent).not.toMatch(/Infinity|NaN/);
   const button=(name:string)=>host.querySelector<HTMLButtonElement>('[aria-label="'+name+'"]')!;
   await act(async()=>button('对比期原装箱出货明细').click());let drill=host.querySelector('[aria-label="期间指标明细"]')!;expect(drill.textContent).toContain('2026-11-05');expect(drill.textContent).not.toContain('2026-12-05');await act(async()=>drill.querySelector<HTMLButtonElement>('tbody button')!.click());expect(openPo).toHaveBeenLastCalledWith('BASELINE');
   const sheet=productionPeriodSheets(data).find(s=>s.name==='期间产出')!;expect(sheet.rows.some(row=>String(row[0]).startsWith('对比期')&&row[7]==='BASELINE')).toBe(true);expect(sheet.rows.some(row=>String(row[0]).startsWith('本期')&&row[7]==='CURRENT')).toBe(true);
   await act(async()=>button('本期原装箱出货明细').click());drill=host.querySelector('[aria-label="期间指标明细"]')!;expect(drill.textContent).toContain('2026-12-05');expect(drill.textContent).not.toContain('2026-11-05');
   await act(async()=>root.render(createElement(ProductionPeriodComparisonTable,{...props,data:project([event('NEW','2026-12-07',1)])})));expect(host.querySelector('[aria-label="期间指标明细"]')).toBeNull();
  }finally{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();}
 });
});
