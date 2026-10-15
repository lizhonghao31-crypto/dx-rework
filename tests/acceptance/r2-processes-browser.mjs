import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DigitalProductionTaskService} from '../../apps/api/src/production-platform/task-service.js';
import {DIGITAL_TASK_ROLES} from '../../apps/api/src/production-platform/task-access-repository.js';
/** UI adapter exercise only. The separate P07 test verifies real ordered business transitions. */
export async function processBrowser({page,context,origin,database,root,actors,sourceId,bulkTaskId,checks,out}){
 const service=new DigitalProductionTaskService(database);
 const kinds=['development_materials','development_material_recheck','development_material_supply','development_pattern','development_cutting','development_craft_dispatch','development_printing','development_embroidery','development_print_embroidery','development_craft_confirmation','development_sewing_transfer','development_sewing','development_washing_dispatch','development_washing','development_tail_check','development_confirmation','development_shipping'];
 for(const kind of kinds){
  const actor=actors[DIGITAL_TASK_ROLES[kind]];assert(actor,kind);
  const client=await database.connect();let id;
  try{await client.query('BEGIN');id=(await service.createWithClient(client,root,{resource:{kind:'source',id:sourceId},kind,routeId:randomUUID(),routeVersion:1,occurrence:100,assigneeId:actor.actorId})).taskId;
   for(const row of (await client.query("SELECT condition_key FROM digital_production_task_conditions WHERE task_id=$1 AND stage='activation'",[id])).rows)await service.setConditionWithClient(client,root,id,row.condition_key,true,undefined,'TEST fixture fulfilled activation');
   await client.query('COMMIT');
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
  assert.equal((await service.read(actor,id)).canExecute,true);
  await context.clearCookies();await context.addCookies([{name:'dx_rework_session',value:actor.actorId,url:origin}]);await page.goto(`${origin}/ui/digital-production?task=${id}`);
  await page.getByLabel('工序工作台样板').waitFor();await page.getByRole('status').filter({hasText:'正在读取原任务条件'}).waitFor({state:'hidden'});
  const actions=page.locator('.task-workbench-sample>footer button:visible');assert.equal(await actions.count(),1,kind+' single main action');
  const footer=await page.locator('.task-workbench-sample>footer').boundingBox();assert(footer.y+footer.height<=page.viewportSize().height+1,kind);
  assert.equal(await page.getByRole('button',{name:'返回来源',exact:true}).count(),1);
  assert.equal(await page.locator('input[type=file]:visible').count(),0,kind+' no duplicate upload in handling');
  if(kind==='development_materials'){
   const boxes=page.locator('.development-material-check-form input[type=checkbox]');await boxes.first().check();
   await page.getByRole('button',{name:'下一页材料',exact:true}).click();assert.equal(await boxes.count(),8);
   await page.getByRole('button',{name:'本单资料',exact:true}).click();await page.getByRole('button',{name:'当前办理',exact:true}).click();
   await page.getByRole('button',{name:'上一页材料',exact:true}).click();assert.equal(await boxes.first().isChecked(),true);
   assert.equal(await page.getByRole('button',{name:'保存人员安排 / 改派',exact:true}).count(),0);
  }
  await page.screenshot({path:`${out}/process-${kind}.png`});
  checks.push(`PR05 ${kind}: original ${DIGITAL_TASK_ROLES[kind]} actor, one adapter/footer, no handling uploader`);
 }
 if(bulkTaskId){
  await context.clearCookies();await context.addCookies([{name:'dx_rework_session',value:actors.pattern_room_worker.actorId,url:origin}]);await page.goto(`${origin}/ui/digital-production?task=${bulkTaskId}`);await page.getByLabel('大货工序工作台').waitFor();await page.getByRole('heading',{name:'大货纸样与唛架办理',exact:true}).waitFor();await page.getByRole('heading',{name:'本轮事实',exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'返回来源',exact:true}).count(),1);assert.equal(await page.locator('input[type=file]').count(),0);
  await page.screenshot({path:`${out}/process-bulk-pattern.png`});checks.push('PR05 bulk paper/marker uses native preparation service and adds no upload requirement');
  const returnTo='/ui/digital-pattern-room?state=all&page=3&round=2',orderId=(await service.read(root,bulkTaskId)).orderId;
  const client=await database.connect();let active;
  try{await client.query('BEGIN');active=(await service.createWithClient(client,root,{resource:{kind:'order',id:orderId},kind:'bulk_pattern',routeId:randomUUID(),routeVersion:1,occurrence:101,assigneeId:actors.pattern_room_worker.actorId})).taskId;
    for(const row of (await client.query("SELECT condition_key FROM digital_production_task_conditions WHERE task_id=$1 AND stage='activation'",[active])).rows)await service.setConditionWithClient(client,root,active,row.condition_key,true,undefined,'TEST fixture activation');
    await client.query('COMMIT');
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
  await context.clearCookies();await context.addCookies([{name:'dx_rework_session',value:root.actorId,url:origin}]);
  const taskUrl=`${origin}/ui/digital-production?task=${active}&returnTo=${encodeURIComponent(returnTo)}`;
  await page.goto(taskUrl);await page.getByLabel('当前任务辅助动作').waitFor();
  await page.locator('summary').filter({hasText:/改派当前.*优先级/}).click();
  await page.getByRole('button',{name:'改派当前岗位',exact:true}).waitFor();
  await page.getByRole('button',{name:'设为优先处理',exact:true}).click();await page.getByRole('button',{name:'恢复普通优先级',exact:true}).waitFor();
  assert.equal((await service.read(root,active)).priority,'urgent');
  assert.equal(await page.getByText('报告问题 / 恢复办理',{exact:true}).count(),1);
  assert.equal(await page.getByText('暂停 / 恢复 / 取消后续任务',{exact:true}).count(),1);
  await page.getByRole('button',{name:'操作记录',exact:true}).click();
  const correction=page.getByRole('link',{name:'核实原任务时间',exact:true});await correction.waitFor();const correctionUrl=new URL(await correction.getAttribute('href'),origin);
  assert.equal(correctionUrl.searchParams.get('returnTo'),returnTo);assert.equal(correctionUrl.searchParams.get('taskView'),'correct');
  await page.goto(taskUrl+'&taskView=read');await page.getByLabel('大货工序工作台').waitFor();assert.equal(await page.getByLabel('当前任务辅助动作').count(),0);
  const dev=(await service.list(root,1)).items.find(t=>t.sourceId===sourceId);
  assert(dev);await page.goto(`${origin}/ui/digital-production?task=${dev.taskId}&returnTo=${encodeURIComponent(returnTo)}`);await page.getByLabel('工序工作台样板').waitFor();await page.getByRole('button',{name:'操作记录',exact:true}).click();await correction.waitFor();
  assert.equal(new URL(await correction.getAttribute('href'),origin).searchParams.get('returnTo'),returnTo);
  checks.push('PR05 review fixes: bulk authorized auxiliary commands, actual priority write, read-only exclusion, both correction links preserve return context');

 }
}
