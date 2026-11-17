import {describe,expect,it} from 'vitest';
import {evaluateSlaPlan,type SlaNodeFact,type SlaPlan} from '../../packages/domain/src/digital-sla-plan.js';

const start='2026-11-21T04:00:00.000Z',deadline='2026-11-25T04:00:00.000Z',warning='2026-11-24T06:24:00.000Z';
const plan:SlaPlan={nodes:[{id:'paper',label:'纸样',stage:2,parameterKey:'development_pattern',applicable:'yes',countsProgress:true,kind:'duration',minutes:4320,offsetDays:null,dependsOn:[],anchorKey:'published',targetKey:null,includedIn:null,includedPosition:'end'}],anchors:{published:{precision:'instant',value:start,source:'TEST native publication'}},warningPercent:70,stageBufferMinutes:0};
// Independently fixed fixture: 72 work hours excluding the entire Beijing
// Sunday. Its explicit 70% warning is 50.4 work hours, not 70% of the 96h wall span.
const native={startedAt:start,deadline:{at:deadline,exclusive:false,reasons:[]},warningAt:warning,calendar:'beijing_sunday_excluded' as const,sourceRef:'task:TEST-paper:round:1'};
const fact={startedAt:start,standardMinutes:4320,standardCalendar:'beijing_sunday_excluded',standardWarningPercent:70,evidence:'task:TEST-paper:round:1',responsibilityWindow:native} as SlaNodeFact & {responsibilityWindow:typeof native};
const evaluate=(at:string,value:SlaNodeFact=fact)=>evaluateSlaPlan(plan,{paper:value},{now:at,scenarioId:null,revision:0})[0]!;
describe('captured native responsibility window projection',()=>{
 it('preserves Sunday D and captured warning without replacing frozen P or interpolating its wall span',()=>{
  const before=evaluate('2026-11-24T04:00:00.000Z');
  expect(before.deadline.at).toBe(deadline);expect(before.status).toBe('running');
  expect(before.forecast.at).toBe(deadline);expect(before.forecastBasis).toBe('standard_window');
  expect(before.end.at).toBe('2026-11-24T04:00:00.000Z');
  expect(evaluate('2026-11-24T06:23:59.999Z').status).toBe('running');
  expect(evaluate(warning).status).toBe('warning');
  expect(evaluate('2026-11-25T03:59:59.999Z').status).toBe('warning');
  expect(evaluate(deadline).status).toBe('warning');
  expect(evaluate('2026-11-25T04:00:00.001Z').status).toBe('overdue');
 });
 it('keeps the separate ordinary continuous legacy window and its inclusive exact deadline',()=>{
  const continuous:SlaNodeFact={startedAt:start,standardMinutes:4320,standardCalendar:'continuous',evidence:'TEST old continuous'};
  expect(evaluate('2026-11-24T04:00:00.000Z',continuous)).toMatchObject({deadline:{at:'2026-11-24T04:00:00.000Z'},status:'warning'});
  expect(evaluate('2026-11-24T04:00:00.001Z',continuous).status).toBe('overdue');
 });
 it('preserves a captured window through later policy values and a disabled native warning',()=>{
  const disabled={...fact,standardMinutes:60,responsibilityWindow:{...native,warningAt:null}};
  expect(evaluate('2026-11-25T03:59:59.999Z',disabled)).toMatchObject({deadline:{at:deadline},status:'running',forecast:{at:deadline}});
  expect(evaluate('2026-11-25T04:00:00.001Z',disabled).status).toBe('overdue');
 });
 it('keeps trustworthy A but declines responsibility when the captured window belongs to a different R',()=>{
  const mismatch={...fact,responsibilityWindow:{...native,startedAt:'2026-11-20T04:00:00.000Z'}};
  expect(evaluate('2026-11-25T05:00:00.000Z',mismatch)).toMatchObject({status:'unknown',deadline:{at:null},forecast:{at:null}});
  const completed={...mismatch,completedAt:'2026-11-21T05:00:00.000Z',completedDeadline:native.deadline,businessCompleted:true};
  expect(evaluate('2026-11-25T05:00:00.000Z',completed)).toMatchObject({status:'completed_unrated',deadline:{at:null},actualEnd:completed.completedAt,forecast:{at:completed.completedAt}});
 });
});
