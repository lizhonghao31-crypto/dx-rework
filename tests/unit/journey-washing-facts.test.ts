import {it,expect} from 'vitest';
import type {BulkWashingScopeView} from '@dx-rework/contracts/bulk-washing';
import type {WashingPlan} from '../../apps/api/src/production-platform/bulk-washing-repository.js';
import {journeyWashingFact} from '../../apps/api/src/production-platform/journey-washing-facts.js';
import {evaluateFixedScheduleScope} from '../../apps/api/src/production-platform/fixed-schedule-progress.js';
const at=(hour:number)=>new Date(Date.UTC(2027,0,1,hour)).toISOString();
const policy={minutes:120,calendar:'beijing_sunday_excluded' as const,reminder:{enabled:false,percent:70}};
const plan:WashingPlan={id:'plan',orderId:'order',lineId:'red',version:1,document:{arrangement:{mode:'after_receipt',accounting:'additional',reference:'original',revision:1,washing:policy,inspection:policy},fee:{kind:'pending'},sourceRef:'original'}};
function batch():BulkWashingScopeView{return {scopeId:'receipt:1',lineId:'red',factoryDecisionId:null,quantityVersion:'v1',quantity:30,planId:'plan',mode:'after_receipt',label:'TEST',revision:1,receivedAt:at(0),availableAt:at(0),canLogistics:false,canInspect:false,canCorrect:false,
 windows:[{id:'send',kind:'washing',state:'completed',startedAt:at(0),dueAt:at(2),completedAt:at(3),minutes:120,overdueMinutes:60},{id:'check',kind:'inspection',state:'completed',startedAt:at(3),dueAt:at(5),completedAt:at(4),minutes:120,overdueMinutes:0}],
 ledger:{applicable:true,conflict:false,reasons:[],sent:30,washed:30,qualified:30,remaining:0,complete:true,completedAt:at(4),sendable:0},facts:[]};}
it('keeps partial PO and separate washing/inspection actuals, including original calendar and batch deadline',()=>{
 const row=batch(),partial=journeyWashingFact([row],[plan],'red','bulk_return_washing',100,at(8));
 expect(partial.businessCompleted).toBe(false);expect(partial.completed).toEqual({precision:'unknown'});
 expect(partial.ownWindows?.[0]).toMatchObject({deadline:at(2),calendar:'beijing_sunday_excluded',complete:true});
 expect(journeyWashingFact([row],[plan],'red','bulk_return_washing',30,at(8)).completed).toEqual({precision:'instant',at:at(3)});
 expect(journeyWashingFact([row],[plan],'red','bulk_return_washing_inspection',30,at(8)).completed).toEqual({precision:'instant',at:at(4)});
 expect(journeyWashingFact([row],[plan],'blue','bulk_return_washing',30,at(8)).businessCompleted).toBe(false);
});
it('does not turn untrusted first starts or withdrawn quantities into valid completion',()=>{
 const row=batch();row.windows[0]!.startedAt=null;
 expect(journeyWashingFact([row],[plan],'red','bulk_return_washing',30,at(8)).clockStart).toEqual({precision:'unknown'});
 row.ledger.conflict=true;
 expect(journeyWashingFact([row],[plan],'red','bulk_return_washing',30,at(8)).businessCompleted).toBe(false);
 row.ledger.conflict=false;row.ledger.qualified=20;
 expect(journeyWashingFact([row],[plan],'red','bulk_return_washing_inspection',30,at(8)).businessCompleted).toBe(false);
});
it('keeps a known overdue batch with another unknown batch instead of declaring all within',()=>{
 const first=batch(),second=batch();second.scopeId='receipt:2';second.windows[0]!.startedAt=null;second.windows[0]!.dueAt=null;
 const fact=journeyWashingFact([first,second],[plan],'red','bulk_return_washing',60,at(8));
 const result=evaluateFixedScheduleScope({scopeRef:'po:red',lineId:'red',targetRevision:'v1',customerGoal:at(30),terminalIds:['wash'],facts:{wash:fact},work:[{id:'wash',canonicalWorkRef:'wash',dependsOn:[],start:at(0),end:at(5),minutes:120,calendar:'continuous',responsibilitySlaRef:'own'}]},at(8));
 expect(result.nodes[0]!.ownSla.state).toBe('overdue');
 expect(result.nodes[0]!.ownSla.deadlineAt).toBeNull();
});
