import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {businessAnchorFixture} from '../helpers/business-anchor-fixture.js';
import {SourcingService} from '../../apps/api/src/sourcing/sourcing-service.js';
import {TodoService} from '../../apps/api/src/todos/service.js';
import {TodoProjectionService} from '../../apps/api/src/todos/projection-service.js';
import {DigitalProductionAccessService} from '../../apps/api/src/production-platform/access-service.js';
import {sourcingSlaEvidence} from '../../apps/api/src/production-platform/sourcing-sla-evidence.js';
import {testExecutionConfig} from '../../scripts/test-execution-config.mjs';

vi.setConfig({testTimeout:testExecutionConfig.correctnessTimeoutMs,hookTimeout:testExecutionConfig.correctnessTimeoutMs});
const url=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
(url?describe:describe.skip)('digital owner approval requires real handling readiness',()=>{
 let f:Awaited<ReturnType<typeof businessAnchorFixture>>;
 beforeAll(async()=>{f=await businessAnchorFixture(url!);});
 afterAll(async()=>{await f?.dispose();});
 it('does not charge missing-staff waiting, starts after the original assignment and never restarts on later reassignment',async()=>{
  const scene=await f.scene('2026-11-09T08:00:00Z'),run=<T>(work:()=>Promise<T>)=>f.runtime.run(scene,f.root,work);
  const native=new SourcingService(f.db,undefined,undefined,new TodoProjectionService(new TodoService(f.db)),f.contracts);
  let orderId='',caseId='';const stop=new Error('TEST stop fixture at the real pending-owner stage');
  const management=native.recordManagementDecision.bind(native);
  const managementSpy=vi.spyOn(native,'recordManagementDecision').mockImplementation(async(...args)=>{
   caseId=args[1];orderId=(await f.db.query("SELECT production_order_id FROM digital_production_child_links WHERE module='sourcing' AND child_id=$1",[caseId])).rows[0].production_order_id;
   // Explicit isolated missing-staff precondition, not a claimed public
   // unassignment command. All approval and personnel actions below are native.
   await f.db.query('UPDATE digital_production_orders SET primary_merchandiser_id=NULL WHERE production_order_id=$1',[orderId]);
   return management(...args);
  });
  const ownerSpy=vi.spyOn(native,'decideOwner').mockRejectedValueOnce(stop);
  try{await expect(run(()=>f.bulkReady('无',undefined,1,native))).rejects.toBe(stop);}
  finally{managementSpy.mockRestore();ownerSpy.mockRestore();}
  const todos=async()=>(await f.db.query("SELECT todo_id,due_at FROM rework_todos WHERE entity_type='sourcing_case' AND entity_id=$1 AND category='sourcing_owner_approval' ORDER BY todo_id",[caseId])).rows;
  expect(await todos()).toEqual([]);
  expect((await sourcingSlaEvidence(f.db,orderId)).sourcing_approval).toBeUndefined();
  await expect(run(()=>native.decideOwner(f.people.owner!,caseId,{decision:'approved'},randomUUID()))).rejects.toThrow('请先在本单指派有效主跟单');
  await f.advance(scene,'2026-11-11T12:00:00Z');
  const access=new DigitalProductionAccessService(f.db),version=async()=>(await f.db.query('SELECT version FROM digital_production_orders WHERE production_order_id=$1',[orderId])).rows[0].version;
  await run(async()=>access.assignMerchandiser(f.root,orderId,f.people.merchandiser!.actorId,await version()));
  const opened=await todos();expect(opened.length).toBeGreaterThan(0);
  const parameter=(await f.db.query('SELECT parameters_json FROM digital_sla_order_snapshots WHERE production_order_id=$1 ORDER BY revision DESC LIMIT 1',[orderId])).rows[0].parameters_json.sourcing_approval.value;
  expect(parameter.kind).toBe('duration');
  for(const todo of opened)expect(todo.due_at.toISOString()).toBe(new Date(Date.parse('2026-11-11T12:00:00Z')+parameter.minutes*60000).toISOString());
  expect((await sourcingSlaEvidence(f.db,orderId)).sourcing_approval?.startedAt).toBe('2026-11-11T12:00:00.000Z');
  await f.advance(scene,'2026-11-12T12:00:00Z');
  await run(async()=>access.assignMerchandiser(f.root,orderId,f.people.merchandiser!.actorId,await version()));
  expect(await todos()).toEqual(opened);
  const approved=await run(()=>native.decideOwner(f.people.owner!,caseId,{decision:'approved'},randomUUID()));
  expect(approved.value.status).toBe('pending_finance_reconciliation');
 });
});
