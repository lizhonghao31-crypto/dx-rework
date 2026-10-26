import {z} from 'zod';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import type {AuthService} from '../auth/service.js';
import type {RootAuthority} from '../access/root-authority.js';
import {AcceptanceClockCreateSchema,AcceptanceClockAdvanceSchema,AcceptanceClockPreviewSchema,AcceptanceClockStandardSchema} from '@dx-rework/contracts/acceptance-clock';
import {ApplicationError} from '../platform/errors.js';
import {acceptanceClockActor,registerAcceptanceClockHooks} from './hooks.js';
import {AcceptanceClockControlService} from './control-service.js';
import {clockRoots} from './scope.js';
import type {AcceptanceClockRuntime} from './runtime.js';

export function registerAcceptanceClockRoutes(app:FastifyInstance,runtime:AcceptanceClockRuntime,auth:AuthService,root:RootAuthority|undefined){
 runtime.assertEnabled();
 registerAcceptanceClockHooks(app,runtime,auth,root);
 const service=new AcceptanceClockControlService(runtime);
 const actor=(request:FastifyRequest)=>acceptanceClockActor(request,auth,root,runtime);
 const id=(request:FastifyRequest)=>z.object({id:z.uuid()}).parse(request.params).id;
 app.get('/acceptance/clock/standards',async request=>{
  await actor(request);return (await runtime.database.query('SELECT configuration_id AS id,version,created_at AS "recordedAt" FROM digital_sla_configurations ORDER BY version DESC LIMIT 100')).rows;
 });
 app.get('/acceptance/clock/scenarios',async request=>{
  await actor(request);
  const rows=(await runtime.database.query('SELECT scenario_id FROM acceptance_sla_clock_scenarios ORDER BY created_at DESC LIMIT 50')).rows;
  return {scenarios:await Promise.all(rows.map(r=>runtime.repository.view(r.scenario_id)))};
 });
 app.post('/acceptance/clock/scenarios',async request=>runtime.create(await actor(request),AcceptanceClockCreateSchema.parse(request.body)));
 app.get('/acceptance/clock/resource/:id',async request=>{
  await actor(request);
  const roots=await clockRoots(runtime.database,id(request)),ids=[...new Set(roots.map(r=>r.scenarioId).filter(Boolean))];
  if(ids.length>1)throw new ApplicationError('ACCEPTANCE_CLOCK_CONFLICT','业务关联跨测试场景',409);
  return {scene:ids[0]?await runtime.repository.view(ids[0]):null};
 });
 app.get('/acceptance/clock/scenarios/:id',async request=>{await actor(request);return runtime.repository.view(id(request));});
 app.get('/acceptance/clock/scenarios/:id/targets',async request=>service.targets(id(request),await actor(request)));
 app.get('/acceptance/clock/scenarios/:id/receipts',async request=>{
  await actor(request);return (await runtime.database.query('SELECT native_kind,native_event_id,recipient_id,business_time,details_json,recorded_at FROM acceptance_sla_clock_receipts WHERE scenario_id=$1 ORDER BY recorded_at DESC LIMIT 100',[id(request)])).rows;
 });
 app.post('/acceptance/clock/scenarios/:id/preview',async request=>service.preview(id(request),await actor(request),AcceptanceClockPreviewSchema.parse(request.body)));
 app.post('/acceptance/clock/scenarios/:id/advance',async request=>service.advance(id(request),await actor(request),AcceptanceClockAdvanceSchema.parse(request.body)));
 app.post('/acceptance/clock/scenarios/:id/standard',async request=>service.standard(id(request),await actor(request),AcceptanceClockStandardSchema.parse(request.body)));
 app.post('/acceptance/clock/scenarios/:id/scan',async request=>service.scan(id(request),await actor(request),z.object({requestKey:z.uuid()}).strict().parse(request.body).requestKey));
}
