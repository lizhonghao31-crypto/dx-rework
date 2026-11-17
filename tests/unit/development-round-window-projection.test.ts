import {afterEach,describe,expect,it,vi} from 'vitest';
import {digitalSlaDefaults,resolveDigitalSlaSnapshot} from '@dx-rework/contracts/digital-sla';
import {developmentSlaEvidence} from '../../apps/api/src/production-platform/development-sla-evidence.js';
import {developmentSlaPlan} from '../../apps/api/src/production-platform/development-sla-enrollment.js';
vi.mock('../../apps/api/src/production-platform/development-sla-enrollment.js',()=>({developmentSlaPlan:vi.fn()}));
const snapshot=resolveDigitalSlaSnapshot({version:1,values:digitalSlaDefaults()});
const r1='2026-11-15T17:48:17.004Z',d1='2026-11-17T17:48:17.004Z',a1='2026-11-15T17:49:28.066Z';
const r2='2026-11-15T17:58:21.813Z',d2='2026-11-17T17:58:21.813Z',a2='2026-11-15T18:00:28.066Z';
afterEach(()=>vi.restoreAllMocks());
describe('same-kind development responsibility across explicit rounds',()=>{
 for(const kind of ['development_pattern','development_external_pattern'])it.each([true,false])(`${kind} does not borrow the first round window, current=%s`,async current=>{
  const id=kind==='development_external_pattern'?'external_pattern':kind;
  const row=(round:number,start:string,due:string,completed:string)=>({task_id:'TEST-task-'+round,task_kind:kind,route_version:round,route_instance_id:'TEST-route-'+round,state:'completed',entered_at:start,task_entered_at:start,entered_quality:'现场登记',completed_at:completed,completed_quality:'已核实',due_at:due,returned:false,rejected:false,sla_basis:{seconds:172800,timeQuality:'现场登记',enteredAt:start,calendarRef:'continuous',basis:[]}});
  const rows=[row(1,r1,d1,a1),...(current?[row(2,r2,d2,a2)]:[])];
  vi.mocked(developmentSlaPlan).mockResolvedValue({business_time:{scenarioId:null},revision:1,rule_version:snapshot.ruleVersion,parameters_json:snapshot.parameters,plan_json:{nodes:[{id}]}});
  const db={query:vi.fn(async(sql:string)=>sql.startsWith('SELECT t.task_id,')?{rows}:sql.startsWith('SELECT round_number')?{rows:[{round_number:2,route_nodes:[kind],inherited:{},published_at:r2}]}:Promise.reject(Error('Unexpected round query: '+sql)))};
  const evidence=(await developmentSlaEvidence(db as never,'TEST-source',{now:'2026-11-16T00:00:00.000Z',scenarioId:null,revision:0}))!;
  expect(evidence.originalFacts[id]).toMatchObject({startedAt:r1,completedAt:a1,completedDeadline:{at:d1}});
  if(current){
   expect(evidence.facts[id]).toMatchObject({startedAt:r2,completedAt:a2,completedDeadline:{at:d2}});
   expect((Date.parse(evidence.facts[id]!.completedAt!)-Date.parse(evidence.facts[id]!.startedAt!))/1000).toBe(126.253);
  }else{
   expect(evidence.facts[id]!.businessCompleted).toBe(false);
   expect(evidence.facts[id]!.startedAt).toBeUndefined();expect(evidence.facts[id]!.completedAt).toBeUndefined();expect(evidence.facts[id]!.completedDeadline).toBeUndefined();
  }
 });
});
