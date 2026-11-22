import {expect,it} from 'vitest';
import type {JourneyFrameworkScope,JourneyTimeFramework} from '@dx-rework/contracts/time-framework-journey';
import type {ScheduleGoalDelta} from '@dx-rework/contracts';
import type {FixedScheduleBasis} from '../../apps/api/src/production-platform/fixed-schedule-basis.js';
import type {ScheduleScopeInput,ScheduleWork} from '../../apps/api/src/production-platform/fixed-schedule-progress.js';
import {cockpitStageDates} from '../../apps/api/src/production-platform/cockpit-stage-dates.js';

const asOf='2027-03-10T00:00:00.000Z';
const delta:ScheduleGoalDelta={kind:'unknown',signedValue:null,unit:'day',asOf,targetAt:null,targetPrecision:'date',
 targetDate:null,actual:{precision:'unknown'},targetRevision:'original',scopeRef:'po:red'};
function milestone(key:JourneyFrameworkScope['milestones'][number]['key'],targetDate:string|null){
 return {key,targetDate,plannedAt:null,workIds:['tail'],relatedWorkIds:['predecessor','tail','included'],completed:false,
  actual:{precision:'unknown'},delta,forecast:{kind:'unknown',earliest:null,latest:null},feasibility:'unknown',lateMinutes:null,coverage:[]} satisfies JourneyFrameworkScope['milestones'][number];
}
const work=(id:string,stage:number,end:string):ScheduleWork=>({id,canonicalWorkRef:id,stage,end,start:asOf,
 dependsOn:[],minutes:1440,calendar:'continuous',responsibilitySlaRef:null});
function scope(lineId:string,cutting:string,production:string):ScheduleScopeInput{
 return {scopeRef:'po:'+lineId,lineId,targetRevision:'adoption:'+lineId,
  work:[work('test_cutting',4,cutting),work('test_production',6,production),work('tail',5,production),
   {...work('included',5,production),includedIn:'tail'}],facts:{},terminalIds:[],customerGoal:null};
}
function plan(lineId:string,missing:boolean):JourneyFrameworkScope{
 return {scopeRef:'po:'+lineId,lineId,route:missing?'A':'B',reference:'plan:'+lineId,revision:2,effectiveAt:asOf,
  customerDate:'2027-04-30',milestones:[milestone('material_investment','2027-03-29'),
   milestone('fabric_receipt',missing?null:'2027-04-08'),milestone('style_label_ready','2027-04-11'),
   ...(missing?[milestone('color_confirmation','2027-04-10')]:[])]};
}
function fixture(){
 const basis:FixedScheduleBasis={version:'fixed-schedule-basis-v1',scopeRevision:'combined',factRevision:'facts',
  scopes:[scope('red','2027-04-13T00:00:00.000Z','2027-04-27T00:00:00.000Z'),
   scope('blue','2027-04-15T00:00:00.000Z','2027-04-29T00:00:00.000Z')],termination:null,pending:false};
 const framework:JourneyTimeFramework={version:'journey-time-framework-v1',asOf,scopes:[plan('red',false),plan('blue',true)],
  applicableWork:5,completedWork:0};
 return {basis,framework};
}
it('uses every applicable target or waits, and keeps original opening and production dates in each PO',()=>{
 const {basis,framework}=fixture(),before=structuredClone({basis,framework});
 const [red,blue]=cockpitStageDates(basis,framework);
 expect(red?.stages.find(row=>row.key==='preparation')).toMatchObject({expected:{precision:'date',date:'2027-04-11'},missingTargets:[]});
 expect(blue?.stages.find(row=>row.key==='preparation')).toMatchObject({expected:{precision:'unknown'},missingTargets:['fabric_receipt']});
 expect(red?.stages.find(row=>row.key==='cutting')).toMatchObject({expected:{precision:'instant',at:'2027-04-13T00:00:00.000Z'},expectedSource:'stage_schedule'});
 expect(blue?.stages.find(row=>row.key==='production')).toMatchObject({expected:{precision:'instant',at:'2027-04-29T00:00:00.000Z'},expectedSource:'stage_schedule'});
 expect(red?.milestoneMembers[0]).toMatchObject({workIds:['tail','included'],prerequisiteIds:['predecessor']});
 expect({basis,framework}).toEqual(before);
});
it('does not silently pick a duplicate milestone target or lone matching line from another PO',()=>{
 const {basis,framework}=fixture();
 const red=framework.scopes[0]!;
 red.milestones.push(milestone('fabric_receipt','2027-04-30'));
 expect(cockpitStageDates(basis,framework)[0]?.stages.find(row=>row.key==='preparation')).toMatchObject({
  expected:{precision:'unknown'},missingTargets:['fabric_receipt']});
 expect(cockpitStageDates(basis,{...framework,scopes:[{...red,lineId:'blue'}]})).toEqual([]);
});
it('keeps a proven completion with unknown occurrence separate from a different unfinished PO',()=>{
 const {basis,framework}=fixture(),red=basis.scopes[0]!;
 basis.scopes[0]={...red,facts:{test_production:{ready:{precision:'unknown'},clockStart:{precision:'unknown'},
  completed:{precision:'unknown'},businessCompleted:true,waitingForPredecessors:false,evidenceRefs:[]}}};
 const [own,other]=cockpitStageDates(basis,framework);
 expect(own?.stages.find(row=>row.key==='production')).toMatchObject({actualComplete:true,actual:{precision:'unknown'}});
 expect(other?.stages.find(row=>row.key==='production')).toMatchObject({actualComplete:false,actual:{precision:'unknown'}});
});
