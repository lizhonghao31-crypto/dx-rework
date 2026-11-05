// @vitest-environment jsdom
import {act,createElement} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,expect,it} from 'vitest';
import type {SeriesPlanState,SeriesPlanSnapshot} from '@dx-rework/contracts/digital-series-plan';
import {seriesMilestones} from '@dx-rework/domain/series-plan';
import {SeriesPlanReading} from '../../apps/web/src/series-plan-reading.js';
const profile={customerCode:null,version:0,monthOffset:-2,shippingDay:null,suggestionDay:15,configured:false} as const;
const snapshot=(revision:number,date:string):SeriesPlanSnapshot=>({revision,plannedShippingDate:date,route:'A',salesYear:2027,salesSeries:'P05',profile,milestones:seriesMilestones(date,'A').slice(0,2).map((row,index)=>({...row,targetDate:index?'2026-11-05':'2026-11-04'})),plannedDurations:{},reason:'TEST原采用依据',createdBy:'TEST',recordedAt:'2026-11-01T01:00:00Z'});
let host:HTMLDivElement,root:Root;
const state=(current:SeriesPlanSnapshot,history:SeriesPlanSnapshot[]=[]):SeriesPlanState=>({orderId:'TEST-Q',serverToday:'2026-11-05',orderVersion:2,sourceId:'TEST-source',canEditSeries:false,canApply:false,canRequest:false,active:true,salesYear:2027,salesSeries:'P05',requiresColorMatching:true,profile,customerDates:[],current,history:[current,...history],facts:[],risks:[],pendingRequests:[]});
const render=async(value:SeriesPlanState,stale=false)=>act(async()=>root.render(createElement(SeriesPlanReading,{state:value,stale})));
beforeEach(()=>{Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});host=document.createElement('div');document.body.append(host);root=createRoot(host);});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();});
it('updates the adopted version, dates, target set and bar atomically; today is not past local day end',async()=>{
 const first=snapshot(1,'2027-03-15');await render(state(first));expect(host.textContent).toContain('当前已采用系列计划第1版');expect(host.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('1');
 await render(state(first),true);expect(host.textContent).toContain('上次读取的采用系列计划第1版');expect(host.textContent).not.toContain('第2版');
 const second=snapshot(2,'2027-03-18');second.milestones=[{...second.milestones[0]!,targetDate:'2026-11-06'}];await render(state(second,[first]));expect(host.textContent).toContain('当前已采用系列计划第2版');expect(host.textContent).toContain('本版计划出货：2027-03-18');expect(host.textContent).toContain('本版保存1项目标');expect(host.querySelector('[role="progressbar"]')?.getAttribute('aria-valuemax')).toBe('1');expect(host.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('0');
});
it('switches history as one saved snapshot and never reuses current actuals or a full bar for partial target dates',async()=>{
 const old=snapshot(1,'2027-03-15'),current=snapshot(2,'2027-03-18');old.milestones[1]!.targetDate=null;current.milestones.push({...current.milestones[0]!,id:'TEST-extra'});await render(state(current,[old]));
 const select=host.querySelector('select')!;await act(async()=>{select.value='1';select.dispatchEvent(new Event('change',{bubbles:true}));});const reading=host.querySelector('[data-reading-plan-revision]')!;
 expect(reading.getAttribute('data-reading-plan-revision')).toBe('1');expect(reading.textContent).toContain('历史系列计划第1版');expect(reading.textContent).toContain('本版计划出货：2027-03-15');expect(reading.textContent).toContain('本版保存2项目标');expect(reading.textContent).toContain('另1项目标日期未保存');expect(reading.textContent).toContain('不能据今天的实绩重算历史完成比例');expect(reading.querySelector('[role="progressbar"]')).toBeNull();expect(reading.textContent).not.toContain('2027-03-18');
 await render(state(current,[]));expect(host.textContent).toContain('该版本已无法读取');expect(host.querySelector('[data-reading-plan-revision]')).toBeNull();
});
