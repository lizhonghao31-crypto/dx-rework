import {expect,it} from 'vitest';
import type {JourneyNode,OrderJourney} from '@dx-rework/contracts/digital-production-journey';
import {minimalJourneyFacts,journeyFactFingerprint} from '../../apps/api/src/production-platform/journey-fact-model.js';
import type {JourneyFactTask} from '../../apps/api/src/production-platform/journey-fact-model.js';
import {evaluateSlaPlan,type SlaPlan} from '@dx-rework/domain/digital-sla-plan';
const node:JourneyNode={key:'development_pattern',instanceId:'TEST-current',label:'TEST',stage:'development',state:'inherited',round:2,occurrence:1,current:true,
 owner:{id:'TEST-owner',name:'PRIVATE name'},operator:null,assignmentHistory:[],expectedAt:'2026-11-08',expectedKind:'plan',expectedPrecision:'date',deadlineMode:'date_target',deadlineExclusive:true,
 actualAt:null,actualDate:null,actualQuality:'missing',enteredAt:null,sla:'not_started',completionResult:null,overdueSeconds:null,risks:['overdue'],blockers:[],
 records:[{domain:'task',id:'TEST-current',lineId:'TEST-po',version:2,url:'/ui/private-secret',mode:'handle'}],countsInProgress:true,unavailableReason:null,
 inheritedFrom:{taskId:'TEST-original',round:1},inheritedResult:{actualAt:'2026-11-01T00:00:00.000Z',quality:'verified',adoptedAt:'2026-11-02T00:00:00.000Z',adoptedRound:2,adoptionSourceRef:'development-round:TEST-source:2',reason:'真实采用'}};
const item:OrderJourney={id:'TEST-order',sourceId:'TEST-source',orderId:'TEST-order',designStyleNo:'PRIVATE style',temporaryStyleNo:null,customer:'PRIVATE customer',category:null,designer:null,styleName:null,merchandisers:[],orderNumbers:[],createdAt:'2026-11-01T00:00:00.000Z',deliveryDate:null,selectedRound:2,adoptedRound:2,sourceVersion:3,instructionVersion:1,lines:[],links:[],stages:[{key:'development',label:'TEST',state:'inherited',nodes:[node]}],progress:{development:null,bulk:null},hitReasons:[]};
it('roundtrips the captured native responsibility window while rejecting unrelated private fields and still reads old facts',()=>{
 const startedAt='2026-11-21T04:00:00.000Z',dueAt='2026-11-25T04:00:00.000Z';
 const window={startedAt,deadline:{at:dueAt,exclusive:false,reasons:[] as string[]},warningAt:'2026-11-24T06:24:00.000Z',calendar:'beijing_sunday_excluded' as const,sourceRef:'task:TEST-pattern:round:2',privateActor:'PRIVATE'};
 const p:SlaPlan={nodes:[{id:'pattern',label:'纸样',stage:2,parameterKey:'development_pattern',applicable:'yes',countsProgress:true,kind:'duration',minutes:4320,offsetDays:null,dependsOn:[],anchorKey:'published',targetKey:null,includedIn:null,includedPosition:'end'}],anchors:{published:{precision:'instant',value:startedAt,source:'TEST native'}},warningPercent:70,stageBufferMinutes:0};
 const model=minimalJourneyFacts(item,{plan:p,original:p,facts:{pattern:{startedAt,evidence:window.sourceRef,responsibilityWindow:window}}});
 expect(model.sla.facts.pattern!.responsibilityWindow).toEqual({startedAt,deadline:window.deadline,warningAt:window.warningAt,calendar:window.calendar,sourceRef:window.sourceRef});
 expect(JSON.stringify(model)).not.toContain('PRIVATE');
 expect(evaluateSlaPlan(model.sla.plan!,model.sla.facts,{now:'2026-11-24T04:00:00.000Z',scenarioId:null,revision:0})[0]).toMatchObject({deadline:{at:dueAt},forecast:{at:dueAt},status:'running'});
 const fingerprint=journeyFactFingerprint(model);window.deadline.reasons.push('MUTATED');expect(journeyFactFingerprint(model)).toBe(fingerprint);
 const old=minimalJourneyFacts(item,{plan:null,original:null,facts:{pattern:{evidence:'TEST legacy'}}});expect(old.sla.facts.pattern).toEqual({evidence:'TEST legacy'});
});
it('stores only explicit facts, not identity, action, attachment, price or time-sensitive status fields',()=>{
 const source=structuredClone(item);Object.assign(source,{authorizationCapabilities:['PRIVATE privilege'],unitPrice:'PRIVATE money',styleImageUrl:'/api/private-image'});Object.assign(source.stages[0]!.nodes[0]!,{canExecute:true,privateToken:'PRIVATE token'});
 const original=structuredClone(source),model=minimalJourneyFacts(source,{plan:null,original:null,facts:{pattern:{evidence:'TEST native',startedAt:'2026-11-01T00:00:00.000Z',businessCompleted:true,...{canExecute:true,price:'PRIVATE price'}}}});
 const json=JSON.stringify(model);expect(json).not.toContain('PRIVATE');expect(json).not.toContain('/ui/');expect(json).not.toContain('/api/');expect(json).not.toContain('canExecute');expect(json).not.toContain('risks');expect(json).not.toContain('overdueSeconds');expect(source).toEqual(original);
 expect(model.nodes[0]!.scopes).toEqual([{domain:'task',id:'TEST-current',lineId:'TEST-po',version:2}]);expect(model.sla.facts.pattern).toEqual({evidence:'TEST native',startedAt:'2026-11-01T00:00:00.000Z',businessCompleted:true});
});
it('retains the original responsibility calendars in the shared facts without copying additional metadata',()=>{
 const input={evidence:'native',standardCalendar:'beijing_sunday_excluded' as const,batchWindows:[{startedAt:'2026-11-07T00:00:00Z',deadline:'2026-11-09T00:00:00Z',warningAt:null,completedAt:null,complete:false,evidence:'batch',calendarRef:'beijing_sunday_excluded' as const,...{actorName:'PRIVATE'}}]};
 const model=minimalJourneyFacts(item,{plan:null,original:null,facts:{factory:input}});
 expect(model.sla.facts.factory).toMatchObject({standardCalendar:'beijing_sunday_excluded',batchWindows:[{calendarRef:'beijing_sunday_excluded'}]});
 expect(JSON.stringify(model)).not.toContain('PRIVATE');
});
it('keeps explicit packing work completion separate from whole-order closure through the shared whitelist',()=>{
 const input=structuredClone(item);input.stages[0]!.nodes[0]!.key='packing';input.stages[0]!.nodes[0]!.completesOrder=false;
 const stored=JSON.parse(JSON.stringify(minimalJourneyFacts(input,{plan:null,original:null,facts:{}})));
 expect(stored.nodes[0].completesOrder).toBe(false);
 delete input.stages[0]!.nodes[0]!.completesOrder;
 expect(minimalJourneyFacts(input,{plan:null,original:null,facts:{}}).nodes[0]).not.toHaveProperty('completesOrder');
});
it('retains date precision, unknown execution start, original result and separate actual adoption without synthesizing midnight',()=>{
 const dependencies=[{taskId:'TEST-current',predecessorId:'TEST-prior',...{canExecute:true}}];
 const model=minimalJourneyFacts(item,{plan:null,original:null,facts:{}},[],dependencies),n=model.nodes[0]!;
 expect(n).toMatchObject({expectedAt:'2026-11-08',expectedPrecision:'date',deadlineExclusive:true,actualAt:null,enteredAt:null,inheritedResult:{actualAt:'2026-11-01T00:00:00.000Z',adoptedAt:'2026-11-02T00:00:00.000Z',quality:'verified'}});
 expect(n.inheritedResult!.actualAt).not.toBe(n.inheritedResult!.adoptedAt);expect(n.inheritedFrom).toEqual({taskId:'TEST-original',round:1});
 expect(model.dependencies).toEqual([{taskId:'TEST-current',predecessorId:'TEST-prior'}]);
});
it('fingerprints facts independently of reader/observation and does not retain source object references',()=>{
 const original=structuredClone(item),a=minimalJourneyFacts(original,{plan:null,original:null,facts:{}}),before=journeyFactFingerprint(a);
 const later={...structuredClone(item),asOf:'2026-11-15T00:00:00.000Z',styleImageUrl:'/api/new-original'};later.stages[0]!.nodes[0]!.risks=[];
 expect(journeyFactFingerprint(minimalJourneyFacts(later,{plan:null,original:null,facts:{}}))).toBe(before);
 original.stages[0]!.nodes[0]!.inheritedFrom!.taskId='MUTATED';expect(journeyFactFingerprint(a)).toBe(before);
 a.nodes[0]!.expectedAt='2026-11-09';expect(journeyFactFingerprint(a)).not.toBe(before);
});
it('keeps an equivalent task/dependency set stable when PostgreSQL returns a different row order',()=>{
 const task=(id:string):JourneyFactTask=>({id,kind:'development_pattern',sourceId:'TEST-source',orderId:null,assigneeId:null,requiredRole:'pattern_room_worker',routeInstanceId:'TEST-route',routeVersion:1,policyVersion:1,enteredAt:null,dueAt:null,warningAt:null,deadlineMode:null,deadlineExclusive:false});
 const deps=[{taskId:'TEST-b',predecessorId:'TEST-a'},{taskId:'TEST-c',predecessorId:'TEST-b'}];
 const a=minimalJourneyFacts(item,{plan:null,original:null,facts:{}},[task('TEST-b'),task('TEST-a')],deps),b=minimalJourneyFacts(item,{plan:null,original:null,facts:{}},[task('TEST-a'),task('TEST-b')],[...deps].reverse());
 expect(a).toEqual(b);expect(journeyFactFingerprint(a)).toBe(journeyFactFingerprint(b));
});
it('whitelists native readiness, cut/factory identities and termination without sharing actor or authorization results',()=>{
 const native={readiness:[{taskId:'TEST-ready',tracked:true,eventId:'TEST-event',effectiveEventId:'TEST-correction',firstReadyAt:null,quality:'缺失',scopeRef:'TEST-scope',basis:['TEST-native'],privateUser:'PRIVATE'}],
  termination:{kind:'cancelled' as const,at:null,precision:'unknown' as const,originEventRef:'TEST-cancel',scopeRef:'TEST-order',canClose:true},
  cutScopes:[{lineId:'TEST-line',status:'verified' as const,cuts:[{cuttingOrderId:'TEST-cut',sourcingCaseId:'TEST-case',sourcingLinePosition:1,approvalSnapshotId:'TEST-snapshot',sourceLineId:'TEST-line',style:'PRIVATE'}]}],
  factoryTimeline:[{productionId:'TEST-production',factoryDecisionId:null,lineId:'TEST-line',quantity:10,dispatchedAt:'2026-11-08T12:00:00.123Z',startTransitionRef:'TEST-transition',completedDate:'2026-11-09',completionTransitionRef:'TEST-completed',actorName:'PRIVATE'}]};
 const model=minimalJourneyFacts(item,{plan:null,original:null,facts:{}},[],[],native),before=journeyFactFingerprint(model);
 expect(model.nativeReadiness![0]!.firstReadyAt).toBeNull();expect(model.factoryTimeline![0]!.completedDate).toBe('2026-11-09');
 expect(JSON.stringify(model)).not.toMatch(/PRIVATE|canClose|actorName|privateUser/);
 native.readiness[0]!.basis.push('MUTATED');native.cutScopes[0]!.cuts[0]!.cuttingOrderId='MUTATED';
 expect(journeyFactFingerprint(model)).toBe(before);
});
