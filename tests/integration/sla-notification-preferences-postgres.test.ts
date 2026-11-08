import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {businessAnchorFixture} from '../helpers/business-anchor-fixture.js';
import {DigitalProductionTaskService} from '../../apps/api/src/production-platform/task-service.js';
import {DigitalProductionNotificationService} from '../../apps/api/src/production-platform/notification-service.js';
import {slaNotificationPreferences} from '../../apps/api/src/production-platform/sla-notification-preferences.js';

const url=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
(url?describe.sequential:describe.skip)('Final10 original PostgreSQL notification switches retain clocks, scope and old frozen standards',()=>{
 let f:Awaited<ReturnType<typeof businessAnchorFixture>>|undefined,tasks:DigitalProductionTaskService,notifications:DigitalProductionNotificationService;
 let oldOrder:string,newOrder:string,oldTask:string,newTask:string,oldShip:string,newShip:string,deadlineRows:Record<string,unknown>[];
 const fixture=()=>{if(!f)throw Error('Owned original fixture missing');return f;};
 const readTasks=async()=> (await fixture().db.query(`SELECT t.task_id,a.production_order_id,a.source_id,a.task_kind,d.due_at,d.warning_at,d.sla_basis FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id)
 JOIN LATERAL(SELECT * FROM digital_production_deadline_revisions d WHERE d.task_id=t.task_id ORDER BY revision_id DESC LIMIT 1)d ON true WHERE t.task_id=ANY($1::uuid[])`,[[oldTask,newTask,oldShip,newShip]])).rows;
 const clocks=async()=> (await fixture().db.query('SELECT * FROM digital_production_deadline_revisions WHERE task_id=ANY($1::uuid[]) ORDER BY task_id,revision_id',[[oldTask,newTask,oldShip,newShip]])).rows;
 const timedTask=async(order:string)=>{
  const {db,root,people}=fixture(),client=await db.connect();try{await client.query('BEGIN');const result=await tasks.createWithClient(client,root,{resource:{kind:'order',id:order},kind:'production_sheet',routeId:randomUUID(),routeVersion:1,occurrence:1,assigneeId:people.merchandiser!.actorId});expect((await client.query('SELECT state FROM digital_production_tasks WHERE task_id=$1',[result.taskId])).rows[0].state).toBe('ready');await client.query('COMMIT');return result.taskId;}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
 };
 const observe=async(at:number,run:()=>Promise<void>)=>{vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(at);try{await run();}finally{vi.useRealTimers();}};
 beforeAll(async()=>{
  f=await businessAnchorFixture(url!);tasks=new DigitalProductionTaskService(f.db);notifications=new DigitalProductionNotificationService(f.db);
  oldOrder=(await f.bulkReady('无')).id;oldTask=await timedTask(oldOrder);
  const current=await tasks.slaSettings(f.root),values=structuredClone(current.values),warning=values.warning_ratio!,sample=values.ship_sample_advance!;if(warning.kind!=='ratio'||sample.kind!=='offset')throw Error('Original reminder types missing');values.warning_ratio={...warning,notificationEnabled:false};values.ship_sample_advance={...sample,notificationEnabled:false};
  const input={expectedVersion:current.version,values,reason:'TEST mute only future original warning/sample notifications'},preview=await tasks.previewSlaSettings(f.root,input);expect(await tasks.publishSlaSettings(f.root,{...input,previewToken:preview.token},randomUUID())).toMatchObject({existingOrdersChanged:0});
  newOrder=(await f.bulkReady('无')).id;newTask=await timedTask(newOrder);
  for(const [order,save]of [[oldOrder,(id:string)=>{oldShip=id;}],[newOrder,(id:string)=>{newShip=id;}]] as const){const row=(await f.db.query("SELECT task_id FROM digital_production_task_access WHERE production_order_id=$1 AND task_kind='bulk_ship_sample'",[order])).rows[0];if(!row)throw Error('Original ship sample task missing');save(row.task_id);}
  deadlineRows=await clocks();expect((await readTasks()).every(row=>row.due_at)).toBe(true);
 });
 afterAll(async()=>{vi.useRealTimers();await f?.dispose();});
 it('reads exact original frozen flags in a batch while a new standard leaves the earlier order enabled',async()=>{
  const flags=await slaNotificationPreferences(fixture().db,await readTasks());expect(flags.get(oldTask)).toEqual({warning:true,shipSample:true});expect(flags.get(newTask)).toEqual({warning:false,shipSample:false});
  const rows=await readTasks();expect(rows.find(row=>row.task_id===newShip)!.sla_basis.targets.every((target:{notificationEnabled:boolean})=>target.notificationEnabled===false)).toBe(true);
 });
 it('suppresses only the new warning and keeps original recipients and one-event idempotency for the old order',async()=>{
  const rows=await readTasks(),windows=rows.filter(row=>[oldTask,newTask].includes(row.task_id));expect(windows.every(row=>row.warning_at)).toBe(true);const at=Math.max(...windows.map(row=>new Date(row.warning_at).getTime()))+1;expect(at).toBeLessThan(Math.min(...windows.map(row=>new Date(row.due_at).getTime())));
  await observe(at,async()=>{await notifications.runOnce();await notifications.runOnce();expect((await fixture().db.query("SELECT task_id FROM digital_production_notification_events WHERE task_id=ANY($1::uuid[]) AND event_kind='warning'",[[oldTask,newTask]])).rows.map(row=>row.task_id)).toEqual([oldTask]);
   const primary=fixture().people.merchandiser!,seen:string[]=[];for(let count=0;count<100;count++){const notice=(await notifications.claim(primary)).notification;if(!notice)break;if(notice.route.entityId===oldTask)seen.push(notice.title);}expect(seen.some(title=>title.includes('即将超时'))).toBe(true);
  });expect(await clocks()).toEqual(deadlineRows);
 });
 it('mutes the new sample target notice while preserving every task target and the original order notice',async()=>{
  const rows=(await readTasks()).filter(row=>[oldShip,newShip].includes(row.task_id)),at=Math.max(...rows.map(row=>new Date(row.due_at).getTime()))+1;
  await observe(at,async()=>{await notifications.runOnce();await notifications.runOnce();expect((await fixture().db.query("SELECT task_id FROM digital_production_notification_events WHERE task_id=ANY($1::uuid[]) AND event_kind='overdue'",[[oldShip,newShip]])).rows.map(row=>row.task_id)).toEqual([oldShip]);});expect(await clocks()).toEqual(deadlineRows);
 });
 it('does not introduce a fake independent sender or switch for the page-only shipping advance rule',async()=>{
  const current=await tasks.slaSettings(fixture().root),values=structuredClone(current.values),value=values.order_shipping_reminder!;if(value.kind!=='offset')throw Error('Original page-only offset missing');values.order_shipping_reminder={...value,notificationEnabled:false};await expect(tasks.previewSlaSettings(fixture().root,{expectedVersion:current.version,values,reason:'TEST reject unsupported notification channel'})).rejects.toMatchObject({statusCode:400});expect(await clocks()).toEqual(deadlineRows);
 });
});
