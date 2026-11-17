import {expect,it} from 'vitest';
import type {WashingReworkCandidate} from '../../apps/api/src/production-platform/bulk-washing-rework-planning.js';
import {washingReworkPlanningInput} from '../../apps/api/src/production-platform/bulk-washing-rework-planning.js';
import {fixedTimelineForward} from '../../apps/api/src/production-platform/fixed-timeline-targets.js';

const candidate:WashingReworkCandidate={orderId:'TEST-order',lineId:'TEST-line',scopeId:'receipt:TEST-receipt',factoryDecisionId:null,
 quantityVersion:'TEST-quantity',inspectionId:'TEST-inspection',inspectionAt:'2026-11-10T06:00:00.000Z',availableQuantity:2,round:1,
 plan:{id:'TEST-plan',orderId:'TEST-order',lineId:'TEST-line',version:1,document:{sourceRef:'TEST original adoption',fee:{kind:'pending'},
  arrangement:{mode:'after_receipt',reference:'TEST original policy',revision:1,accounting:'additional',
   washing:{minutes:120,calendar:'continuous',reminder:{enabled:true,percent:80}},
   inspection:{minutes:60,calendar:'continuous',reminder:{enabled:true,percent:80}}}}}};
const identity='00000000-0000-4000-8000-000000000001';

it('prepares independent work before a real start and uses the existing effective-time maximum, not a deadline or completion',()=>{
 const prepared=washingReworkPlanningInput(candidate,identity,1);
 const result=fixedTimelineForward(prepared.work.map(work=>({id:work.id,dependsOn:[...work.dependsOn],
  minutes:work.nativeDuration!.minutes,calendar:work.nativeDuration!.calendar})),
  {precision:'instant',value:'2026-11-01T00:00:00.000Z',source:'TEST accepted order'},prepared.notBefore,
  {minimumStart:{precision:'instant',value:'2026-11-10T08:00:00.000Z',source:'TEST authorized arrangement'}});
 expect(result.map(row=>[row.start.at,row.end.at])).toEqual([
  ['2026-11-10T08:00:00.000Z','2026-11-10T10:00:00.000Z'],
  ['2026-11-10T10:00:00.000Z','2026-11-10T11:00:00.000Z'],
 ]);
 expect(prepared.work[1]!.dependsOn).toEqual([prepared.work[0]!.id]);
 expect(prepared.requiredForDelivery).toBe(prepared.work[1]!.id);
 expect(prepared).not.toHaveProperty('actualAt');expect(prepared).not.toHaveProperty('deadline');
});

it('keeps an explicitly chosen work identity and missing prerequisite separate from later snapshots',()=>{
 const first=washingReworkPlanningInput(candidate,identity,1),later=washingReworkPlanningInput({...candidate,inspectionAt:null},identity,1);
 expect(later.work).toEqual(first.work);expect(later.notBefore[first.work[0]!.id]).toMatchObject({precision:'unknown'});
 expect(()=>washingReworkPlanningInput(candidate,identity,3)).toThrow('超过');
 expect(()=>washingReworkPlanningInput(candidate,'not-an-identity',1)).toThrow();
 expect(candidate.availableQuantity).toBe(2);
});

it('keeps a missing original inspection occurrence unknown instead of substituting the arrangement time',()=>{
 const prepared=washingReworkPlanningInput({...candidate,inspectionAt:null},identity,1);
 const result=fixedTimelineForward(prepared.work.map(work=>({id:work.id,dependsOn:[...work.dependsOn],
  minutes:work.nativeDuration!.minutes,calendar:work.nativeDuration!.calendar})),
  {precision:'instant',value:'2026-11-01T00:00:00.000Z',source:'TEST accepted order'},prepared.notBefore,
  {minimumStart:{precision:'instant',value:'2026-11-10T08:00:00.000Z',source:'TEST authorized arrangement'}});
 expect(result.every(row=>row.start.at===null&&row.end.at===null)).toBe(true);
 expect(result[0]!.start.reasons).toContain('本批原不合格检查的真实发生时间待核');
});
