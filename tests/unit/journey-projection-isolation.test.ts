import type * as Enrollment from '../../apps/api/src/production-platform/development-sla-enrollment.js';
import type * as DevelopmentEvidence from '../../apps/api/src/production-platform/development-sla-evidence.js';
import {beforeEach,expect,it,vi} from 'vitest';
import type {Pool,PoolClient} from 'pg';
import type {JourneyNode,OrderJourney} from '@dx-rework/contracts/digital-production-journey';
import {digitalTaskTiming} from '@dx-rework/domain/digital-task-deadline';
import {evaluateSlaPlan,type SlaPlan,type SlaNodeFact} from '@dx-rework/domain/digital-sla-plan';
import {ApplicationError} from '../../apps/api/src/platform/errors.js';
const fixture=vi.hoisted(()=>({plan:null as SlaPlan|null,facts:{} as Record<string,SlaNodeFact>,error:null as Error|null}));
vi.mock('../../apps/api/src/production-platform/development-sla-enrollment.js',async original=>({...await original<typeof Enrollment>(),developmentSlaPlan:async()=>{
 if(fixture.error)throw fixture.error;return {plan_json:fixture.plan,revision:1};
}}));
vi.mock('../../apps/api/src/production-platform/development-sla-evidence.js',async original=>({...await original<typeof DevelopmentEvidence>(),developmentSlaEvidence:async()=>({facts:fixture.facts}),developmentEvaluationPlan:()=>fixture.plan}));
import {readJourneySupervision} from '../../apps/api/src/production-platform/journey-supervision.js';
const time={now:'2026-10-20T00:00:00.000Z',scenarioId:null,revision:0};
const actor={actorId:'TEST-root',actorRoles:['root_superuser'],authorizationCapability:'digital_production:view',requestId:'TEST-projection-request'};
const item=()=>({id:'TEST-source',sourceId:'TEST-source',orderId:null,lines:[],stages:[{nodes:['development_pattern','development_sewing'].map(key=>({key,instanceId:'TEST-'+key,label:key,stage:'development',current:true,state:'active',round:1,occurrence:1,owner:null,operator:null,assignmentHistory:[],expectedAt:null,expectedKind:'unset',expectedPrecision:'missing',actualAt:null,actualQuality:'missing',enteredAt:null,sla:'not_set',completionResult:null,overdueSeconds:null,risks:[],blockers:[],records:[],inheritedFrom:null,countsInProgress:true,unavailableReason:null} satisfies JourneyNode))}]} as unknown as OrderJourney);
beforeEach(()=>{
 fixture.error=null;fixture.plan={nodes:['development_pattern','development_sewing'].map(id=>({id,label:id,stage:2,parameterKey:id,kind:'duration',minutes:120,offsetDays:null,applicable:'yes',countsProgress:true,dependsOn:[],anchorKey:'published',targetKey:null,includedIn:null,includedPosition:'start'})),anchors:{published:{precision:'instant',value:'2026-10-19T00:00:00.000Z',source:'TEST original native publication'}},warningPercent:70,stageBufferMinutes:0};
 fixture.facts={development_pattern:{startedAt:'2026-10-19T02:00:00.000Z',completedAt:'2026-10-19T01:00:00.000Z',evidence:'TEST old inconsistent fact'},development_sewing:{startedAt:'2026-10-19T00:00:00.000Z',evidence:'TEST valid independent fact'}};
});
it('isolates a classified bad authorized projection without losing an independently provable overdue node',async()=>{
 const legacy={query:vi.fn(async(sql:string)=>{if(sql==="SELECT to_regclass('digital_timeline_adoptions') AS relation")return {rows:[{relation:null}],rowCount:1};throw Error('Unexpected legacy projection query: '+sql);})} as unknown as PoolClient;
 const row=item();await readJourneySupervision({} as Pool,legacy,actor,row,time);
 expect(row.supervision?.nodes.find(n=>n.id==='development_pattern')?.status).toBe('unknown');
 expect(row.supervision?.nodes.find(n=>n.id==='development_sewing')?.status).toBe('overdue');
 expect(row.supervision?.coverage.some(c=>c.message.includes('不可评估'))).toBe(true);
});
it('retains strict calculation for commands and other default callers',()=>{
 expect(()=>evaluateSlaPlan(fixture.plan!,fixture.facts,time)).toThrow('SLA completion precedes start');
});
it.each([new Error('TEST database unavailable'),new ApplicationError('FORBIDDEN','TEST permission',403),new ApplicationError('ACCEPTANCE_ISOLATION','TEST scope',409)])('does not swallow data-access, permission or scope exceptions: %s',async error=>{
 fixture.error=error;await expect(readJourneySupervision({} as Pool,{} as PoolClient,actor,item(),time)).rejects.toBe(error);
});

it.each(['past','current','future','ordinary'])("%s observation retains invalid future facts as unavailable, never clamps or rewrites them",mode=>{
 const now=new Date(Date.now()+(mode==='past'?-7:mode==='future'?7:0)*86400000).toISOString();
 const observation={now,scenarioId:mode==='ordinary'?null:'TEST-scene',revision:mode==='ordinary'?0:1};
 const invalid={...fixture.facts,development_pattern:{startedAt:new Date(Date.parse(now)+1).toISOString(),evidence:'TEST known legacy future fact'}};
 const before=structuredClone(invalid);
 expect(()=>evaluateSlaPlan(fixture.plan!,invalid,observation)).toThrow('Actual SLA event cannot be in the future');
 const rows=evaluateSlaPlan(fixture.plan!,invalid,observation,{mode:'read_projection'});
 expect(rows.find(n=>n.id==='development_pattern')).toMatchObject({status:'unknown',assessmentIssue:{code:'actual_after_observation'}});expect(invalid).toEqual(before);
});
it('isolates a bad batch node and propagates unknown forecasts without erasing an independent overdue node',()=>{
 const plan=structuredClone(fixture.plan!);plan.nodes.push({...plan.nodes[0]!,id:'downstream',dependsOn:['development_pattern'],anchorKey:null});
 const facts={...fixture.facts,development_pattern:{evidence:'TEST batch',batchWindows:[{startedAt:'2026-10-19T02:00:00.000Z',completedAt:'2026-10-19T01:00:00.000Z',deadline:null,warningAt:null,complete:true,evidence:'TEST native batch'}]}};
 expect(()=>evaluateSlaPlan(plan,facts,time)).toThrow('SLA completion precedes start');
 const rows=evaluateSlaPlan(plan,facts,time,{mode:'read_projection'});
 expect(rows.find(n=>n.id==='development_pattern')?.status).toBe('unknown');expect(rows.find(n=>n.id==='development_sewing')?.status).toBe('overdue');expect(rows.find(n=>n.id==='downstream')?.forecast.at).toBeNull();
});
it.each(['invalid-instant','missing-evidence','invalid-standard','invalid-estimate','invalid-plan'])("does not downgrade %s even when the same node has a classified chronology issue",mode=>{
 const facts=structuredClone(fixture.facts),plan=structuredClone(fixture.plan!);
 if(mode==='invalid-instant')facts.development_pattern!.startedAt='unknown';if(mode==='missing-evidence')facts.development_pattern!.evidence='';if(mode==='invalid-standard')facts.development_pattern!.standardMinutes=-1;if(mode==='invalid-estimate')facts.development_pattern!.remaining={minutes:-1,asOf:time.now,validUntil:time.now,source:'TEST'};if(mode==='invalid-plan')plan.nodes[0]!.dependsOn=['missing-node'];
 expect(()=>evaluateSlaPlan(plan,facts,time,{mode:'read_projection'})).toThrow();
});

it('never converts a reversed original task duration into zero minutes',()=>{
 expect(digitalTaskTiming({slaHours:24,enteredAt:'2026-10-20T02:00:00.000Z',completedAt:'2026-10-20T01:00:00.000Z',terminal:true,dueAt:'2026-10-21T02:00:00.000Z',warningAt:null},new Date('2026-10-20T03:00:00.000Z'))).toMatchObject({state:'unknown',elapsedSeconds:null,onTime:null});
});
it.each([-1,0,1])('rates a date target at Beijing day-end %+i ms without inventing duration start',offset=>{
 const due='2026-10-26T16:00:00.000Z',task={slaHours:null,enteredAt:null,completedAt:null,terminal:false,dueAt:due,warningAt:null,deadlineExclusive:true};
 const value=digitalTaskTiming(task,new Date(Date.parse(due)+offset));expect(value.state).toBe(offset<0?'normal':'overdue');expect(value.elapsedSeconds).toBeNull();
});

it('preserves a separately proved overdue batch while marking a sibling batch chronology unavailable',()=>{
 const facts={...fixture.facts,development_pattern:{evidence:'TEST native batch aggregate',batchWindows:[{startedAt:'2026-10-19T02:00:00.000Z',completedAt:'2026-10-19T01:00:00.000Z',deadline:null,warningAt:null,complete:true,evidence:'TEST bad batch'},{startedAt:'2026-10-19T00:00:00.000Z',completedAt:null,deadline:'2026-10-19T02:00:00.000Z',warningAt:null,complete:false,evidence:'TEST independent valid batch'}]}};
 const rows=evaluateSlaPlan(fixture.plan!,facts,time,{mode:'read_projection'});expect(rows.find(n=>n.id==='development_pattern')).toMatchObject({status:'unknown',provenRisk:'overdue',forecast:{at:null}});
});
