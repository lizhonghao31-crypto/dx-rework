import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe,it,expect} from 'vitest';
import {CockpitDate} from '../../apps/web/src/cockpit-date.js';
import {CockpitStageDifference} from '../../apps/web/src/cockpit-fixed-schedule.js';
import {cockpitDifferenceDays} from '../../apps/web/src/cockpit-difference-days.js';
import type {ScheduleGoalDelta} from '@dx-rework/contracts';
const text=(signedValue:number|null,unit:ScheduleGoalDelta['unit']='minute',kind:ScheduleGoalDelta['kind']='late')=>cockpitDifferenceDays({signedValue,unit,kind});
describe('PR08 approved full date and day-only differences',()=>{
 it('shows signs, at most two decimal days and a true green zero without hiding a tiny nonzero',()=>{
  expect(text(0)).toBe('-0');expect(text(1440)).toBe('+1天');expect(text(-2160)).toBe('-1.5天');expect(text(120)).toBe('+0.08天');
  expect(text(1)).toBe('+<0.01天');expect(text(-0.001)).toBe('-<0.01天');expect(text(14.4)).toBe('+0.01天');expect(text(0.005,'day')).toBe('+<0.01天');
 });
 it('does not convert date precision to hours or resurrect unknown and terminated differences',()=>{
  expect(text(-2,'day','early')).toBe('-2天');expect(text(null)).toBe('—');expect(text(NaN)).toBe('—');expect(text(Infinity)).toBe('—');expect(text(30,'minute','unknown')).toBe('—');expect(text(30,'minute','terminated')).toBe('—');
 });
 it('renders the Beijing full calendar date across UTC year boundary and retains the exact instant',()=>{
  const html=renderToStaticMarkup(createElement(CockpitDate,{value:'2026-12-31T16:30:00Z',precision:'instant',short:true}));
  expect(html).toContain('>2027-01-01</time>');expect(html).toContain('dateTime="2026-12-31T16:30:00Z"');expect(html).toContain('aria-label="2027/1/1 00:30:00"');
 });
 it('retains a date-only value without inventing a midnight or dropping its year',()=>{
  const html=renderToStaticMarkup(createElement(CockpitDate,{value:'2026-11-10',precision:'date',short:true}));
  expect(html).toContain('>2026-11-10</time>');expect(html).not.toContain('T00:00');
  expect(renderToStaticMarkup(createElement(CockpitDate,{value:null,precision:'unknown',short:true,missing:'完成时间待核'}))).toContain('完成时间待核');
 });
 it('renders a tiny late stage in danger color and retains source values',()=>{
  const goal={kind:'late',unit:'minute',signedValue:0.001,actual:{precision:'unknown'},asOf:'2026-11-10T00:00:00Z',targetAt:'2026-11-09T23:59:59.999Z'} as ScheduleGoalDelta;
  const original=structuredClone(goal),html=renderToStaticMarkup(createElement(CockpitStageDifference,{goal}));
  expect(html).toContain('is-danger');expect(html).toContain('+&lt;0.01天');expect(html).not.toMatch(/小时|分钟/);expect(goal).toEqual(original);
 });
});
