import {digitalTaskTiming} from '../../packages/domain/src/digital-task-deadline.js';
import {describe,expect,it} from 'vitest';
import {AcceptanceClockAdvanceSchema,AcceptanceClockCreateSchema,AcceptanceClockPreviewSchema,AcceptanceClockStandardSchema} from '../../packages/contracts/src/acceptance-clock.js';
import {clockRequestIds} from '../../apps/api/src/acceptance-clock/scope.js';
import {observeAcceptanceTime,acceptanceInputNow} from '../../apps/web/src/acceptance-business-time.js';
import {taskTimeProgress} from '../../apps/web/src/digital-cockpit-model.js';
import type {DigitalTask} from '@dx-rework/contracts/digital-production-tasks';
import {loadConfig} from '@dx-rework/config';
import {buildApp} from '../../apps/api/src/app.js';
import type {AcceptanceClockRuntime} from '../../apps/api/src/acceptance-clock/runtime.js';
const id='12345678-1234-4234-8234-123456789abc';
describe('Acceptance clock contracts and client business-time boundary',()=>{
 it('has no clock endpoints in an ordinary server and rejects a clock dependency in production before registration',async()=>{
  const config=loadConfig({NODE_ENV:'test',DATABASE_URL:'postgresql://test@127.0.0.1:1/test',DINGTALK_CORP_ID:'TEST',DINGTALK_H5_APP_KEY:'test',DINGTALK_H5_APP_SECRET:'test',DINGTALK_WEB_CLIENT_ID:'test',DINGTALK_WEB_CLIENT_SECRET:'test',DINGTALK_QR_REDIRECT_URI:'https://example.test/auth/qr/callback',SESSION_SECRET:'TEST-clock-session-secret-with-more-than-32-characters'});
  const dependencies={config,checkDatabase:async()=>{},getAppliedSchemaHistory:async()=>null};
  const app=buildApp(dependencies);
  try{
   expect((await app.inject({method:'GET',url:'/acceptance/clock/scenarios'})).statusCode).toBe(404);
   expect((await app.inject({method:'POST',url:'/digital-production/orders',headers:{'x-acceptance-scenario':id},payload:{}})).statusCode).toBe(403);
  }finally{await app.close();}
  expect(()=>buildApp({...dependencies,config:{...config,nodeEnv:'production'},acceptanceClock:{} as AcceptanceClockRuntime})).toThrow(/unavailable/);
 });
 it('accepts explicit future instants, rejects invalid units/versions/extra enable flags and never accepts raw dependency edits',()=>{
  const valid={expectedVersion:1,requestKey:id,at:'2026-10-27T00:00:00+08:00'};
  expect(AcceptanceClockAdvanceSchema.safeParse(valid).success).toBe(true);
  for(const extra of [{expectedVersion:-1},{expectedVersion:1.5},{at:'2026-10-27'},{at:'infinity'},{enabled:true},{production:true}])expect(AcceptanceClockAdvanceSchema.safeParse({...valid,...extra}).success).toBe(false);
  expect(AcceptanceClockCreateSchema.safeParse({name:'测试',requestKey:id,sourceId:id}).success).toBe(false);
  expect(AcceptanceClockStandardSchema.safeParse({expectedVersion:1,requestKey:id,configurationId:id,values:{development_sewing:1}}).success).toBe(false);
  expect(AcceptanceClockPreviewSchema.safeParse({nodeId:id,boundary:'due_after'}).success).toBe(true);
  expect(AcceptanceClockPreviewSchema.safeParse({nodeId:id,boundary:'complete'}).success).toBe(false);
 });
 it('resolves exact native IDs only, rejects oversized nesting and does not treat labels or file bytes as business IDs',()=>{
  expect(clockRequestIds({orderId:id,lines:[{lineId:id}],label:id,bytes:Buffer.from('test')})).toEqual([id]);
  let nested:unknown={orderId:id};for(let n=0;n<20;n++)nested={nested};
  expect(()=>clockRequestIds(nested)).toThrow(/嵌套/);
 });
 it('keeps Date.now and unrelated page defaults real while providing an exact scoped business input default',()=>{
  const before=Date.now(),at='2035-01-01T01:02:03.000Z';
  observeAcceptanceTime(id,at);expect(acceptanceInputNow().toISOString()).toBe(at);expect(Date.now()-before).toBeLessThan(1000);
  observeAcceptanceTime('another',null);expect(acceptanceInputNow().toISOString()).toBe(at);
  observeAcceptanceTime(id,null);expect(Math.abs(acceptanceInputNow().getTime()-Date.now())).toBeLessThan(1000);
 });
 it('uses the server-observed scene time for both status and elapsed percentage without changing business completion',()=>{
  const task={state:'ready',enteredAt:'2026-10-26T00:00:00Z',dueAt:'2026-10-26T04:00:00Z',warningAt:'2026-10-26T02:48:00Z',completedAt:null,paused:false,acceptanceBusinessNow:'2026-10-26T03:00:00Z'} as DigitalTask;
  expect(taskTimeProgress(task,new Date('2026-10-26T00:00:00Z'))).toMatchObject({percent:75,label:expect.stringContaining('临期')});
  expect(task.state).toBe('ready');
 });
 it('keeps instant equality on time, date midnight exclusive, and legacy task comparison unchanged',()=>{
  const task={slaHours:4,enteredAt:'2026-10-26T00:00:00Z',completedAt:null,terminal:false,dueAt:'2026-10-26T04:00:00Z',warningAt:'2026-10-26T02:48:00Z'},at=new Date(task.dueAt);
  expect(digitalTaskTiming({...task,deadlineExclusive:false},at).state).toBe('attention');
  expect(digitalTaskTiming({...task,deadlineExclusive:true},at).state).toBe('overdue');
  expect(digitalTaskTiming(task,at).state).toBe('overdue');
  expect(digitalTaskTiming({...task,terminal:true,completedAt:task.dueAt,deadlineExclusive:false},at).onTime).toBe(true);
  expect(digitalTaskTiming({...task,terminal:true,completedAt:task.dueAt,deadlineExclusive:true},at).onTime).toBe(false);
 });

});
