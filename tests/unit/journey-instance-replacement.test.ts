import {expect,it} from 'vitest';
import type {JourneyNode} from '@dx-rework/contracts/digital-production-journey';
import {appendJourneyInstance,journeyStages} from '../../apps/api/src/production-platform/journey-projection.js';
const node=(id:string,round:number|null,state:JourneyNode['state']='uncreated'):JourneyNode=>({key:'rework',label:'返工',stage:'receiving',instanceId:id,state,current:true,round,occurrence:null,owner:null,operator:null,assignmentHistory:[],expectedAt:null,expectedKind:'unset',expectedPrecision:'missing',actualAt:null,actualQuality:'missing',enteredAt:null,sla:'not_started',completionResult:null,overdueSeconds:null,risks:[],blockers:[],records:state==='uncreated'?[]:[{domain:'rework',id,url:'/ui/tasks/'+id,version:round,lineId:'TEST-PO',mode:'read'}],inheritedFrom:null,countsInProgress:true,unavailableReason:null});
it('replaces the no-record rework placeholder while retaining distinct original business objects',()=>{
 const rows=[node('rework:0',null)],first=node('TEST-rework-A',null,'completed'),second=node('TEST-rework-B',null,'active');
 appendJourneyInstance(rows,first);expect(rows).toEqual([first]);expect(journeyStages(rows).find(s=>s.key==='receiving')?.state).toBe('completed');
 appendJourneyInstance(rows,second);expect(rows).toEqual([first,second]);expect(journeyStages(rows).find(s=>s.key==='receiving')?.state).toBe('active');
});
it('never overwrites prior-round history or another round placeholder merely because the node key matches',()=>{
 const history={...node('TEST-rework-old',1,'completed'),current:false},next=node('rework:2',2),rows=[history,next];
 const priorRound=node('TEST-rework-first',1,'completed');appendJourneyInstance(rows,priorRound);expect(rows).toEqual([history,next,priorRound]);
 const current=node('TEST-rework-second',2,'active');appendJourneyInstance(rows,current);expect(rows).toEqual([history,current,priorRound]);
});
it('retains a catalogue-shaped real record and only removes the empty unavailable slot',()=>{
 const real=node('rework:1',1,'completed'),unavailable={...node('rework:2',2),state:'unavailable' as const},rows=[real,unavailable];
 const next=node('TEST-rework-next',2,'completed');appendJourneyInstance(rows,next);expect(rows).toEqual([real,next]);
});
