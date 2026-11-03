import {describe,expect,it} from 'vitest';
import {digitalSlaDefaults,resolveDigitalSlaSnapshot} from '../../packages/contracts/src/digital-sla.js';
import {calculateSlaPlan,evaluateSlaPlan,type SlaNodeFact} from '../../packages/domain/src/digital-sla-plan.js';
import {buildOrderSlaRoute} from '../../apps/api/src/production-platform/sla-route.js';
import {resolveBulkPreshrinkRequirement} from '../../apps/api/src/production-platform/bulk-preshrink-requirement.js';
import {bulkEvaluationPlan} from '../../apps/api/src/production-platform/bulk-sla-evidence.js';

const start='2026-10-01T00:00:00.000Z';
const plan=()=>buildOrderSlaRoute(resolveDigitalSlaSnapshot({version:1,values:digitalSlaDefaults()}),
 {developmentCraft:'none',washing:'no',bulkCraft:'none'},
 {development_published:{precision:'instant',value:start,source:'fixture:publication'},
  customer_order_confirmed:{precision:'instant',value:start,source:'fixture:confirmation'},
  sourcing_accepted:{precision:'instant',value:start,source:'fixture:sourcing'},
  expected_fabric_arrival:{precision:'instant',value:'2026-11-01T00:00:00.000Z',source:'fixture:estimate'}},['fixture-po']);

describe('bulk preshrink effective requirement',()=>{
 it.each(['需要预缩','无需预缩'] as const)('freezes the explicit published %s choice for a new preparation',choice=>{
  expect(resolveBulkPreshrinkRequirement(null,{preshrink:choice})).toBe(choice);
 });
 it.each([['需要预缩','无需预缩'],['无需预缩','需要预缩']] as const)('retains frozen %s despite a later %s document', (frozen,later)=>{
  expect(resolveBulkPreshrinkRequirement({preshrink:frozen},{preshrink:later})).toBe(frozen);
 });
 it('never turns missing or malformed frozen requirements into an implicit waiver',()=>{
  for(const preshrink of [undefined,null,'',true,'other']){
   expect(resolveBulkPreshrinkRequirement({preshrink},{preshrink:'无需预缩'})).toBeNull();
   expect(resolveBulkPreshrinkRequirement(null,{preshrink})).toBeNull();
  }
  expect(resolveBulkPreshrinkRequirement(null)).toBeNull();
 });
 it('excludes unneeded preshrink from the current projection without changing P0, the 36h standard or actual clocks',()=>{
  const frozen=plan(),before=structuredClone(frozen),effective=bulkEvaluationPlan(frozen,'无需预缩',{});
  expect(frozen).toEqual(before);
  expect(frozen.nodes.find(n=>n.id==='warehouse_preshrink')).toMatchObject({applicable:'yes',minutes:2160});
  expect(effective.nodes.find(n=>n.id==='warehouse_preshrink')).toMatchObject({applicable:'no',minutes:2160});
  expect(effective.nodes.find(n=>n.id==='bulk_cutting')?.dependsOn).toEqual(['fabric_inspection','bulk_pattern']);
  const original=calculateSlaPlan(frozen).find(n=>n.id==='bulk_cutting')!,projected=calculateSlaPlan(effective).find(n=>n.id==='bulk_cutting')!;
  expect(Date.parse(original.start.at!)-Date.parse(projected.start.at!)).toBe(36*3600000);
  const evaluated=evaluateSlaPlan(effective,{}, {now:start,scenarioId:'unit-isolated',revision:1});
  expect(evaluated.find(n=>n.id==='warehouse_preshrink')).toMatchObject({status:'not_applicable',actualStart:null,actualEnd:null});
  expect(evaluated.find(n=>n.id==='bulk_cutting')).toMatchObject({status:'not_started',actualStart:null,actualEnd:null});
 });
 it('keeps inspection as a cutting predecessor when no preshrink is required',()=>{
  const facts={fabric_inspection:{evidence:'fixture:inspection',waitingFor:{reason:'验布未放行',source:'fixture:quality'}}};
  const effective=bulkEvaluationPlan(plan(),'无需预缩',facts);
  const cutting=evaluateSlaPlan(effective,facts,{now:start,scenarioId:'unit-isolated',revision:1}).find(n=>n.id==='bulk_cutting')!;
  expect(cutting.forecast.at).toBeNull();
  expect(cutting.forecast.reasons.join(' ')).toContain('验布未放行');
  expect(cutting.actualStart).toBeNull();
 });
 it.each(['需要预缩',null] as const)('preserves required or unresolved routes (%s)',requirement=>{
  const frozen=plan();expect(bulkEvaluationPlan(frozen,requirement,{})).toBe(frozen);
 });
 it.each([{businessCompleted:true},{completedAt:start}])('never hides an existing completion with facts %j',completion=>{
  const frozen=plan(),facts:Record<string,SlaNodeFact>={warehouse_preshrink:{...completion,evidence:'fixture:original-completion'}};
  expect(bulkEvaluationPlan(frozen,'无需预缩',facts)).toBe(frozen);
  const evaluated=evaluateSlaPlan(frozen,facts,{now:start,scenarioId:'unit-isolated',revision:1});
  expect(evaluated.find(n=>n.id==='warehouse_preshrink')).toMatchObject({status:'completed_unrated',actualEnd:'completedAt' in completion?start:null});
 });
});
