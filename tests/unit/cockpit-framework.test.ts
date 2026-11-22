import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect,it} from 'vitest';
import type {JourneyNode,OrderJourney} from '@dx-rework/contracts/digital-production-journey';
import type {ScheduleNodeProgress} from '@dx-rework/contracts';
import {cockpitMilestones,cockpitScopeContains,milestoneContains,CockpitStageMilestones} from '../../apps/web/src/cockpit-milestones.js';
import {CockpitPlanDates} from '../../apps/web/src/cockpit-framework-nodes.js';
import {CockpitHomeProgress} from '../../apps/web/src/cockpit-home-progress.js';
const goal={kind:'late' as const,signedValue:1440,unit:'minute' as const,asOf:'2027-03-09T00:00:00Z',targetAt:'2027-03-06T00:00:00Z',targetDate:null,targetPrecision:'instant' as const,actual:{precision:'instant' as const,at:'2027-03-07T00:00:00Z'},targetRevision:'original',scopeRef:'po:red'};
const progress={id:'dispatch:whole',scopeRef:'po:red',targetRevision:'new',canonicalWorkRef:'task:shared',state:'normal',lagMinutes:null,businessCompleted:true,availabilityBound:null,creditLimit:null,goalDelta:goal,currentTarget:{at:'2027-03-10T00:00:00Z',date:null,precision:'instant',revision:'new'},ownSla:{state:'within',overdueMinutes:null,sourceRef:'task'},coverage:[]} as ScheduleNodeProgress;
function fixture(){
 const milestone={key:'processing_dispatch',targetDate:'2027-03-10',plannedAt:'2027-03-08T00:00:00Z',workIds:['dispatch:whole'],completed:false,actual:{precision:'unknown'},delta:{...goal,actual:{precision:'unknown'},kind:'on_target',signedValue:0},forecast:{kind:'unknown',earliest:null,latest:null},feasibility:'unknown',lateMinutes:null,coverage:[]};
 return {lines:[{id:'red',po:'TEST red'}],fixedSchedule:{framework:{version:'journey-time-framework-v1',asOf:goal.asOf,applicableWork:1,completedWork:0,scopes:[{scopeRef:'po:red',lineId:'red',route:'B',reference:'TEST',revision:2,effectiveAt:goal.asOf,customerDate:'2027-03-15',milestones:[milestone]}]}}} as unknown as OrderJourney;
}
it('uses scope and work identity for cross-stage milestone membership and excludes inaccessible/history instances',()=>{
 const o=fixture(),m=cockpitMilestones(o)[0]!,n={current:true,state:'active',fixedTargets:[{scopeRef:'po:red',lineId:'red',progress}]} as JourneyNode;
 expect(milestoneContains(m,n)).toBe(true);
 expect(milestoneContains(m,{...n,current:false})).toBe(false);
 expect(milestoneContains(m,{...n,state:'unavailable'})).toBe(false);
 expect(milestoneContains({...m,scopeRef:'po:blue'},n)).toBe(false);
 expect(milestoneContains({...m,directWorkIds:['other']},n)).toBe(false);
 expect(milestoneContains({...m,directWorkIds:['other'],prerequisiteIds:m.workIds},n,'prerequisite')).toBe(true);
});
it('shows the effective plan date without replacing the completed historical +1 day',()=>{
 const n={fixedTargets:[{scopeRef:'po:red',lineId:'red',progress}]} as JourneyNode,before=structuredClone(n);
 const html=renderToStaticMarkup(createElement(CockpitPlanDates,{node:n}));
 expect(html).toContain('2027-03-10');expect(html).not.toContain('2027-03-06');expect(n).toEqual(before);expect(n.fixedTargets![0]!.progress.goalDelta.signedValue).toBe(1440);
});
it('allows proven shared work on both POs and will not infer sharing from an unscoped record',()=>{
 const red={scopeRef:'po:red',lineId:'red'},blue={scopeRef:'po:blue',lineId:'blue'};
 const own={fixedTargets:[{...red,progress}],records:[]} as unknown as JourneyNode;
 expect(cockpitScopeContains(red,own)).toBe(true);
 expect(cockpitScopeContains(blue,own)).toBe(false);
 const shared={...own,fixedTargets:[...own.fixedTargets!,{...blue,progress:{...progress,scopeRef:blue.scopeRef}}]};
 expect(cockpitScopeContains(red,shared)&&cockpitScopeContains(blue,shared)).toBe(true);
 const records=['blue',null].map(lineId=>({lineId,domain:'preparation',id:'record',version:null,mode:'read' as const,url:null}));
 expect(cockpitScopeContains(blue,{...own,fixedTargets:[],records})).toBe(true);
 expect(cockpitScopeContains(red,{...own,fixedTargets:[],records})).toBe(false);
});
it('shows one original milestone in its stage, with full target date and no invented responsibility',()=>{
 const items=cockpitMilestones(fixture()),html=renderToStaticMarkup(createElement(CockpitStageMilestones,{items,selected:items[0]!.selectionKey,onSelect(){},asOf:undefined}));
 expect(html).toContain('2027-03-10');expect(html).toContain('未完成');expect(html).toContain('未到期');expect(html).not.toContain('见节点');expect(html).not.toContain('无责');expect(html).not.toContain('2027-03-08');expect(html.match(/data-milestone-key=/g)).toHaveLength(1);expect(html).not.toContain('<svg');
});
it('homepage shows the customer delivery date, never the internal lower-bound forecast as that date',()=>{
 const o=fixture();o.visualProgress={timeRatio:.25,actualRatio:.5} as OrderJourney['visualProgress'];o.orderId='TEST';
 const html=renderToStaticMarkup(createElement(CockpitHomeProgress,{order:o}));
 expect(html).toContain('2027-03-15');expect(html).not.toContain('2027-03-08');expect(html).not.toContain('预计完成');expect(html).not.toContain('交货日期');expect(html).toContain('aria-label="整单自然时间进度"');expect(html).toContain('实际进度');expect(html.indexOf('2027-03-15')).toBeLessThan(html.indexOf('data-progress-kind="time"'));expect(html).toContain('aria-valuenow="25"');expect(html).toContain('aria-valuenow="50"');
});
it('keeps objective delay independent from own responsibility and missing evidence',async()=>{
 const {frameworkResponsibility}=await import('../../apps/web/src/cockpit-framework-nodes.js');
 const node={state:'completed',fixedTargets:[{scopeRef:'po:red',lineId:'red',progress}]} as JourneyNode;
 expect(frameworkResponsibility(node,undefined).text).toBe('逾期（无责）');
 const late=structuredClone(node);late.fixedTargets![0]!.progress.ownSla.state='overdue';
 expect(frameworkResponsibility(late,undefined).text).toBe('逾期（有责）');
 const missing=structuredClone(node);missing.fixedTargets![0]!.progress.ownSla.state='unknown';
 expect(frameworkResponsibility(missing,undefined).text).toBe('责任待核');
 expect(frameworkResponsibility({...node,planningOnly:true},undefined).text).toBe('不单独计责');
});
it('preserves the explicit all-nodes milestone context through original links',async()=>{
 const {journeyReturnUrl}=await import('@dx-rework/contracts/digital-production-journey');
 const {cockpitContext}=await import('../../apps/web/src/digital-journey-cockpit-model.js');
 const url=journeyReturnUrl({milestone:'',expanded:''});expect(url).toContain('milestone=');expect(cockpitContext(url.slice(url.indexOf('?'))).milestone).toBe('');
});
