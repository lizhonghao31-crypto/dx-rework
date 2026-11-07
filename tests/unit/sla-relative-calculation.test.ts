import {expect,it} from 'vitest';
import type {CalculationGraph,CalculationNode} from '@dx-rework/contracts/sla-calculation';
import {calculateRelativeSlaSummary} from '../../packages/domain/src/sla-relative-calculation.js';
const hour=3600000;
const node=(id:string,minutes:number,patch:Partial<CalculationNode>={}):CalculationNode=>({id,label:id,stage:2,parameterKey:id,applicable:'yes',countsProgress:false,kind:'duration',minutes,offsetDays:null,dependsOn:[],anchorKey:'TEST-publication',targetKey:null,includedIn:null,includedPosition:'start',calendar:'continuous',source:'TEST original standard values',binding:null,...patch});
const graph=(nodes:CalculationNode[],endIds=[nodes.at(-1)!.id]):CalculationGraph=>({observationMode:'example',nodes,anchors:{},warningPercent:70,stageBufferMinutes:0,endIds,rangeLabel:'TEST',startLabel:'TEST',endLabel:'TEST'});
it('relative standards calculate serial windows and cross-stage buffer without creating a timestamp',()=>{
 const g=graph([node('a',120),node('b',180,{stage:3,dependsOn:['a'],anchorKey:null})]);g.stageBufferMinutes=10;const before=structuredClone(g),r=calculateRelativeSlaSummary(g);
 expect(r.overall.spanMs).toBe(5*hour+10*60000);expect(r.stages.find(s=>s.stage===2)?.spanMs).toBe(2*hour);expect(r.stages.find(s=>s.stage===3)?.spanMs).toBe(3*hour);expect(g).toEqual(before);expect(g.anchors).toEqual({});
});
it('relative fork and join follow the longest original branch and react only to critical edits',()=>{
 const g=graph([node('a',120),node('b',180,{dependsOn:['a'],anchorKey:null}),node('c',240,{dependsOn:['a'],anchorKey:null}),node('d',60,{dependsOn:['b','c'],anchorKey:null})]);
 expect(calculateRelativeSlaSummary(g).overall.spanMs).toBe(7*hour);g.nodes[1]!.minutes=120;expect(calculateRelativeSlaSummary(g).overall.spanMs).toBe(7*hour);g.nodes[2]!.minutes=300;expect(calculateRelativeSlaSummary(g).overall.spanMs).toBe(8*hour);
});
it('relative included work, independent supervision and nonapplicable branches do not add to the execution path',()=>{
 const g=graph([node('parent',300),node('child',60,{kind:'included',includedIn:'parent',anchorKey:null}),node('supervision',999,{independent:true}),node('optional',999,{applicable:'no'})],['parent']);
 expect(calculateRelativeSlaSummary(g).overall.spanMs).toBe(5*hour);expect(calculateRelativeSlaSummary(g).stages.find(s=>s.stage===2)?.spanMs).toBe(5*hour);
});
it('relative unknown real event waits and unrelated origins stay unknown while a later fixed stage remains calculable',()=>{
 const g=graph([node('real-ready',0,{kind:'unlimited',minutes:null,stage:2}),node('packing',120,{stage:7,dependsOn:['real-ready'],anchorKey:null})]);const r=calculateRelativeSlaSummary(g);expect(r.overall.spanMs).toBeNull();expect(r.stages.find(s=>s.stage===2)?.spanMs).toBeNull();expect(r.stages.find(s=>s.stage===7)?.spanMs).toBe(2*hour);
 const forks=graph([node('paper',120,{anchorKey:'instruction'}),node('fabric',180,{anchorKey:'actual-fabric'})],['paper','fabric']);expect(calculateRelativeSlaSummary(forks).overall.spanMs).toBeNull();
});
it('relative wall duration never fabricates a weekday, an unknown applicability or a pending real result',()=>{
 expect(calculateRelativeSlaSummary(graph([node('contract',2880,{calendar:'beijing_sunday_excluded'})])).overall.spanMs).toBeNull();expect(calculateRelativeSlaSummary(graph([node('unknown',60,{applicable:'unknown'})])).overall.spanMs).toBeNull();expect(calculateRelativeSlaSummary(graph([node('waiting',60,{waitingFor:'TEST original prerequisite not established'})])).overall.spanMs).toBeNull();
});
it('keeps the longest completely calculable segment visible without calling an unknown whole total complete',()=>{
 const g=graph([node('a',120),node('real-ready',0,{kind:'unlimited',minutes:null,dependsOn:['a'],anchorKey:null}),node('b',180,{dependsOn:['real-ready'],anchorKey:null}),node('c',60,{dependsOn:['b'],anchorKey:null})]);
 const r=calculateRelativeSlaSummary(g);expect(r.overall.spanMs).toBeNull();expect(r.overall.partial).toBe(true);expect(r.overall.knownPathMs).toBe(4*hour);
 const independent=graph([node('paper',120,{anchorKey:'instruction'}),node('fabric',180,{anchorKey:'actual-fabric'})],['paper','fabric']);expect(calculateRelativeSlaSummary(independent).overall).toMatchObject({spanMs:null,knownPathMs:3*hour,partial:true});
});
it('relative route rejects invalid endpoints, calendars, buffers and included sums through the original DAG validation',()=>{
 expect(()=>calculateRelativeSlaSummary({...graph([node('a',60)]),endIds:[]})).toThrow();
 expect(()=>calculateRelativeSlaSummary(graph([node('a',60,{calendar:'TEST-invalid' as never})]))).toThrow();
 expect(()=>calculateRelativeSlaSummary(graph([node('a',60,{stageBufferMinutes:-1})]))).toThrow();
 expect(()=>calculateRelativeSlaSummary(graph([node('a',60),node('b',40,{kind:'included',includedIn:'a',anchorKey:null}),node('c',40,{kind:'included',includedIn:'a',anchorKey:null})],['a']))).toThrow();
});
