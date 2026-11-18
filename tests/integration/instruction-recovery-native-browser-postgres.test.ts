import {randomUUID} from 'node:crypto';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import type {Page} from 'playwright-core';
import {beforeAll,afterAll,describe,it,expect,vi} from 'vitest';
import {supplychainSettingsBrowser} from '../acceptance/supplychain-settings-browser.js';
import {admittedFrameworkProductionFixture,prepareRewashSettings} from '../helpers/order-time-rewash-fixture.js';
import {ProductionInstructionService} from '../../apps/api/src/production-platform/production-instruction-service.js';
import {testExecutionConfig} from '../../scripts/test-execution-config.mjs';

vi.setConfig({testTimeout:testExecutionConfig.correctnessTimeoutMs,hookTimeout:testExecutionConfig.correctnessTimeoutMs});
const url=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
(url?describe.sequential:describe.skip)('original authenticated instruction/decision recovery across real reload',()=>{
 let h:Awaited<ReturnType<typeof supplychainSettingsBrowser>>;
 beforeAll(async()=>{h=await supplychainSettingsBrowser(url!,await mkdtemp(join(tmpdir(),'dx-instruction-recovery-')),{fullApp:true,orderTimeFlow:true,orderTimeModel:true});await prepareRewashSettings(h.f);});
 afterAll(async()=>{if(h){await h.writeEvidence();await h.dispose();}});
 const prepare=async()=>{
  const fixture=await admittedFrameworkProductionFixture(h.f);h.setCollectionScene(fixture.scene);
  const service=new ProductionInstructionService(h.db,true),before=await h.f.runtime.run(fixture.scene,h.f.root,()=>service.read(h.f.root,fixture.orderId));expect(before.canEdit).toBe(true);expect(before.cutStarted).toBe(false);
  return {...fixture,service,before};
 };
 const notices=async(page:Page)=>{
  const notice=page.locator('[aria-label="站内提醒"]');
  for(let i=0;i<16;i++){
   if(!await notice.isVisible())return;
   // The original notification can finish its claim and detach while the
   // button is disabled. Recheck that live state instead of waiting12seconds
   // on a button whose notification has already closed by itself.
   try{await notice.getByRole('button',{name:'我知道了',exact:true}).click({timeout:1000});}
   catch{if(await notice.isVisible())await notice.waitFor({state:'hidden',timeout:1000}).catch(()=>undefined);}
  }
  expect(await notice.isVisible()).toBe(false);
 };
 it('restores raw unsaved instruction input after real reload and stays without writes beyond the original autosave delay',async()=>{
  const f=h.f,fixture=await prepare(),path='/api/digital-production/orders/'+fixture.orderId+'/instruction',tab=await h.open(f.root.actorId,1165,{},'/ui/digital-production?instruction='+fixture.orderId);
  try{
   const page=tab.page;page.on('dialog',dialog=>void dialog.accept());const input=page.locator('#instruction-styleName');await input.waitFor();await notices(page);
   const raw='  TEST 未提交原字符串  ';await input.fill(raw);await page.reload();await input.waitFor();expect(await input.inputValue()).toBe(raw);await page.getByText('已恢复本页未提交修改；不会自动保存，请继续编辑或明确保存。',{exact:true}).waitFor();
   // This wait deliberately checks the existing1200ms autosave boundary.
   await page.waitForTimeout(1350);expect(h.requests.filter(row=>row.session===tab.session&&row.path===path&&row.method==='PUT')).toHaveLength(0);
   const untouched=await f.runtime.run(fixture.scene,f.root,()=>fixture.service.read(f.root,fixture.orderId));expect(untouched.version).toBe(fixture.before.version);expect(untouched.document).toEqual(fixture.before.document);
   await notices(page);const result=page.waitForResponse(response=>response.url().endsWith(path)&&response.request().method()==='PUT');await page.getByRole('button',{name:'保存草稿',exact:true}).click();expect((await result).status()).toBe(200);
   await expect.poll(()=>input.inputValue()).toBe(raw.trim());await page.reload();await input.waitFor();expect(await input.inputValue()).toBe(raw.trim());await page.waitForTimeout(1350);
   expect(h.requests.filter(row=>row.session===tab.session&&row.path===path&&row.method==='PUT')).toHaveLength(1);
  }catch(error){await writeFile(join(h.evidence,'raw-instruction-reload-failure.txt'),await tab.page.locator('body').innerText());throw error;}finally{await tab.context.close();}
 });
 it('recovers a committed PUT lost to503 by one original-key GET after actual reload, without replaying the PUT',async()=>{
  const f=h.f,fixture=await prepare(),path='/api/digital-production/orders/'+fixture.orderId+'/instruction',tab=await h.open(f.root.actorId,390,{},'/ui/digital-production?instruction='+fixture.orderId);
  try{
   const page=tab.page;page.on('dialog',dialog=>void dialog.accept());let lost=false;
   await page.route('**'+path,async route=>{
    if(route.request().method()==='PUT'&&!lost){lost=true;const original=await route.fetch();expect(original.status()).toBe(200);await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'TEST_COMMITTED_SAVE_RECEIPT_LOST',message:'TEST 原保存已提交，浏览器回执丢失'}})});}else await route.continue();
   });
   const input=page.locator('#instruction-styleName');await input.waitFor();await notices(page);const result=page.waitForResponse(response=>response.url().endsWith(path)&&response.request().method()==='PUT');const raw='  TEST 原保存结果未知  ';await input.fill(raw);expect((await result).status()).toBe(503);await page.getByRole('button',{name:'只读核对原制单保存结果',exact:true}).waitFor();
   const calls=h.requests.filter(row=>row.session===tab.session&&row.path===path&&row.method==='PUT');expect(calls).toHaveLength(1);expect(calls[0]!.status).toBe(200);expect(calls[0]!.key).toBeTruthy();
   await page.reload();const check=page.getByRole('button',{name:'只读核对原制单保存结果',exact:true});await check.waitFor();expect(await page.locator('#instruction-styleName').textContent()).toBe(raw);await page.waitForTimeout(1350);expect(h.requests.filter(row=>row.session===tab.session&&row.path===path&&row.method==='PUT')).toHaveLength(1);
   await notices(page);await check.click();await page.getByText('原制单保存已确认成功。',{exact:true}).waitFor();await expect.poll(()=>page.locator('#instruction-styleName').inputValue()).toBe(raw.trim());
   const receipt=h.requests.filter(row=>row.session===tab.session&&row.method==='GET'&&row.path.startsWith(path+'/save-receipt?'));expect(receipt).toHaveLength(1);expect(new URL(receipt[0]!.path,h.base).searchParams.get('key')).toBe(calls[0]!.key);
   const commands=await h.db.query('SELECT payload_hash FROM digital_production_commands WHERE actor_id=$1 AND command=$2 AND key=$3',[f.root.actorId,`instruction:${fixture.orderId}:save`,calls[0]!.key]);expect(commands.rows).toHaveLength(1);expect(commands.rows[0]!.payload_hash).toBe(calls[0]!.bodyHash);
   const after=await f.runtime.run(fixture.scene,f.root,()=>fixture.service.read(f.root,fixture.orderId));expect(after.version).toBe(fixture.before.version+1);expect(after.document.styleName).toBe(raw.trim());expect(h.requests.filter(row=>row.session===tab.session&&row.path===path&&row.method==='PUT')).toHaveLength(1);
  }catch(error){await writeFile(join(h.evidence,'unknown-save-reload-failure.txt'),await tab.page.locator('body').innerText());throw error;}finally{await tab.context.close();}
 });
 it('keeps an independent PO approval envelope across actual reload and reads its receipt without another approval POST',async()=>{
  const f=h.f,fixture=await prepare();
  const requested=await f.runtime.run(fixture.scene,f.root,()=>fixture.service.requestDate(f.root,fixture.orderId,{orderVersion:fixture.before.currentOrderVersion,changes:fixture.before.customerPoDates!.map(row=>({lineId:row.lineId,expectedVersion:row.version,date:'2027-03-05'})),reason:'TEST genuine PO approval response loss'},randomUUID()));
  const original=requested.dateRequests.find(row=>row.reason==='TEST genuine PO approval response loss')!,path=`/api/digital-production/orders/${fixture.orderId}/instruction/date-requests/${original.requestId}/decision`,tab=await h.open(f.root.actorId,1165,{},'/ui/digital-production?instruction='+fixture.orderId);
  try{
   const page=tab.page;page.on('dialog',dialog=>void dialog.accept());let lost=false;
   await page.route('**'+path,async route=>{if(route.request().method()==='POST'&&!lost){lost=true;const response=await route.fetch();expect(response.status()).toBe(200);await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'TEST_COMMITTED_DECISION_LOST',message:'TEST 原批准已提交，浏览器回执丢失'}})});}else await route.continue();});
   const approve=page.getByRole('button',{name:'同意',exact:true});await approve.waitFor();await notices(page);const result=page.waitForResponse(response=>response.url().endsWith(path)&&response.request().method()==='POST');await approve.click();expect((await result).status()).toBe(503);
   await page.getByRole('button',{name:'只读核对原交期决定结果',exact:true}).waitFor();const writes=h.requests.filter(row=>row.session===tab.session&&row.path===path&&row.method==='POST');expect(writes).toHaveLength(1);
   await page.reload();const check=page.getByRole('button',{name:'只读核对原交期决定结果',exact:true});await check.waitFor();await page.waitForTimeout(1350);await notices(page);await check.click();await page.getByText('原客户交期决定已确认成功。',{exact:true}).waitFor();
   const reads=h.requests.filter(row=>row.session===tab.session&&row.path.startsWith(path+'-receipt?')&&row.method==='GET');expect(reads).toHaveLength(1);expect(new URL(reads[0]!.path,h.base).searchParams.get('key')).toBe(writes[0]!.key);expect(new URL(reads[0]!.path,h.base).searchParams.get('approved')).toBe('true');
   expect(h.requests.filter(row=>row.session===tab.session&&row.path===path&&row.method==='POST')).toHaveLength(1);const after=await f.runtime.run(fixture.scene,f.root,()=>fixture.service.read(f.root,fixture.orderId));expect(after.dateRequests.find(row=>row.requestId===original.requestId)?.status).toBe('已批准');expect(after.customerPoDates!.map(row=>row.date)).toEqual(['2027-03-05']);
  }catch(error){await writeFile(join(h.evidence,'unknown-decision-reload-failure.txt'),await tab.page.locator('body').innerText());throw error;}finally{await tab.context.close();}
 });
 it('retains a later raw draft and durable known success when original receipt recovery is followed by a failed current-sheet read',async()=>{
  const f=h.f,fixture=await prepare(),path='/api/digital-production/orders/'+fixture.orderId+'/instruction',fault={readPath:path,failRead:false},tab=await h.open(f.root.actorId,1165,fault,'/ui/digital-production?instruction='+fixture.orderId);
  let release:(()=>void)|undefined;const held=new Promise<void>(resolve=>{release=resolve;});
  try{
   const page=tab.page;page.on('dialog',dialog=>void dialog.accept());let first=true;
   await page.route('**'+path,async route=>{
    if(route.request().method()==='PUT'&&first){first=false;const response=await route.fetch();expect(response.status()).toBe(200);await held;await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'TEST_ORIGINAL_SAVE_LOST',message:'TEST 原保存回执丢失，较新编辑保留'}})});}else await route.continue();
   });
   const input=page.locator('#instruction-styleName');await input.waitFor();await notices(page);const old='  TEST 先提交的原稿  ',newer='  TEST 之后继续输入的稿  ';await input.fill(old);
   await expect.poll(()=>h.requests.filter(row=>row.session===tab.session&&row.method==='PUT'&&row.path===path).length,{timeout:5000}).toBe(1);expect(await input.isDisabled()).toBe(false);await input.fill(newer);release!();
   await page.getByRole('button',{name:'只读核对原制单保存结果',exact:true}).waitFor();await page.reload();const check=page.getByRole('button',{name:'只读核对原制单保存结果',exact:true});await check.waitFor();expect(await page.locator('#instruction-styleName').textContent()).toBe(newer);
   await notices(page);fault.failRead=true;await check.click();await page.getByText('原制单保存已确认成功。',{exact:true}).waitFor();await page.getByRole('alert').filter({hasText:'原提交已确认成功，最新资料尚未读取'}).waitFor();expect(await page.locator('#instruction-styleName').inputValue()).toBe(newer);
   await page.reload();await input.waitFor();expect(await input.inputValue()).toBe(newer);await page.getByText('原制单保存已确认成功。',{exact:true}).waitFor();await page.waitForTimeout(1350);
   expect(h.requests.filter(row=>row.session===tab.session&&row.method==='PUT'&&row.path===path)).toHaveLength(1);
   const saved=await f.runtime.run(fixture.scene,f.root,()=>fixture.service.read(f.root,fixture.orderId));expect(saved.document.styleName).toBe(old.trim());expect(saved.version).toBe(fixture.before.version+1);
   await notices(page);const response=page.waitForResponse(row=>row.url().endsWith(path)&&row.request().method()==='PUT');await page.getByRole('button',{name:'保存草稿',exact:true}).click();expect((await response).status()).toBe(200);await expect.poll(()=>input.inputValue()).toBe(newer.trim());
   const writes=h.requests.filter(row=>row.session===tab.session&&row.method==='PUT'&&row.path===path);expect(writes).toHaveLength(2);expect(writes[1]!.key).not.toBe(writes[0]!.key);expect((await f.runtime.run(fixture.scene,f.root,()=>fixture.service.read(f.root,fixture.orderId))).version).toBe(fixture.before.version+2);
  }catch(error){await writeFile(join(h.evidence,'later-draft-known-success-failure.txt'),await tab.page.locator('body').innerText());throw error;}finally{release?.();await tab.context.close();}
 });
 it('keeps the readonly receipt entry when the original sheet projection is temporarily unavailable after reload',async()=>{
  const f=h.f,fixture=await prepare(),path='/api/digital-production/orders/'+fixture.orderId+'/instruction',fault={readPath:path,failRead:false},tab=await h.open(f.root.actorId,1165,fault,'/ui/digital-production?instruction='+fixture.orderId);
  try{
   const page=tab.page;page.on('dialog',dialog=>void dialog.accept());let first=true;
   await page.route('**'+path,async route=>{if(route.request().method()==='PUT'&&first){first=false;const response=await route.fetch();expect(response.status()).toBe(200);await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'TEST_SAVE_LOST_BEFORE_READ',message:'TEST 原保存结果未知'}})});}else await route.continue();});
   const input=page.locator('#instruction-styleName');await input.waitFor();await notices(page);await input.fill('TEST no current sheet but original receipt retained');await page.getByRole('button',{name:'只读核对原制单保存结果',exact:true}).waitFor();
   fault.failRead=true;await page.reload();const check=page.getByRole('button',{name:'只读核对原制单保存结果',exact:true});await check.waitFor();await page.getByRole('alert').filter({hasText:'TEST 设置读取暂时失败'}).waitFor();expect(await page.locator('#instruction-styleName').count()).toBe(0);await page.waitForTimeout(1350);
   await notices(page);await check.click();await page.getByText('原制单保存已确认成功。',{exact:true}).waitFor();await input.waitFor();expect(await input.inputValue()).toBe('TEST no current sheet but original receipt retained');
   expect(h.requests.filter(row=>row.session===tab.session&&row.path===path&&row.method==='PUT')).toHaveLength(1);expect(h.requests.filter(row=>row.session===tab.session&&row.method==='GET'&&row.path.startsWith(path+'/save-receipt?'))).toHaveLength(1);
  }catch(error){await writeFile(join(h.evidence,'missing-sheet-receipt-entry-failure.txt'),await tab.page.locator('body').innerText());throw error;}finally{await tab.context.close();}
 });
 it('reads only the current authorized actor fixed save command and leaves actual PG business evidence unchanged',async()=>{
  const f=h.f,fixture=await prepare(),path='/api/digital-production/orders/'+fixture.orderId+'/instruction',tab=await h.open(f.root.actorId,1165,{},'/ui/digital-production?instruction='+fixture.orderId);
  try{
   const page=tab.page;await page.locator('#instruction-styleName').waitFor();await notices(page);const key=randomUUID(),response=await page.request.put(h.base+path,{headers:{'idempotency-key':key},data:{expectedVersion:fixture.before.version,orderVersion:fixture.before.order.version,sourceRound:fixture.before.sourceRound,document:{...fixture.before.document,styleName:'TEST minimal original own save receipt'}}});expect(response.status()).toBe(200);
   const snapshot=async()=>(await h.db.query(`SELECT
    (SELECT version FROM digital_instruction_documents WHERE production_order_id=$1) AS version,
    (SELECT count(*)::int FROM digital_instruction_attachment_bindings WHERE production_order_id=$1) AS bindings,
    (SELECT count(*)::int FROM digital_preparation_instruction_events WHERE production_order_id=$1) AS work,
    (SELECT count(*)::int FROM audit_events WHERE entity_id=$1::text) AS audits,
    (SELECT count(*)::int FROM digital_production_commands WHERE command LIKE $2 OR command=$3) AS commands,
    (SELECT count(*)::int FROM digital_production_notification_events WHERE task_id IN(SELECT task_id FROM digital_production_task_access WHERE production_order_id=$1)) AS notifications`,[fixture.orderId,`instruction:${fixture.orderId}:%`,`po-customer:${fixture.orderId}:decision`])).rows[0];
   const before=await snapshot(),read=await page.request.get(h.base+path+'/save-receipt?key='+key);expect(read.status()).toBe(200);const receipt=await read.json();expect(receipt).toMatchObject({status:'completed',action:'save',actorId:f.root.actorId,orderId:fixture.orderId,key,savedVersion:fixture.before.version+1,sourceRound:fixture.before.sourceRound});expect(Object.keys(receipt).sort()).toEqual(['status','action','actorId','orderId','key','payloadHash','savedVersion','orderVersion','sourceRound'].sort());
   const missing=await page.request.get(h.base+path+'/save-receipt?key='+randomUUID());expect(missing.status()).toBe(200);expect(await missing.json()).toMatchObject({status:'unconfirmed',action:'save',actorId:f.root.actorId,orderId:fixture.orderId});
   const published=(await h.db.query('SELECT actor_id,key FROM digital_production_commands WHERE command=$1 LIMIT 1',[`instruction:${fixture.orderId}:publish`])).rows[0]!;expect(published).toBeTruthy();const other=await h.open(published.actor_id,1165,{},'/ui/digital-production?instruction='+fixture.orderId);
   try{
    await other.page.locator('#instruction-styleName').waitFor();const wrongActor=await other.page.request.get(h.base+path+'/save-receipt?key='+key),wrongCommand=await other.page.request.get(h.base+path+'/save-receipt?key='+published.key);expect(wrongActor.status()).toBe(200);expect(wrongCommand.status()).toBe(200);
    expect(await wrongActor.json()).toEqual({status:'unconfirmed',action:'save',actorId:published.actor_id,orderId:fixture.orderId,key});expect(await wrongCommand.json()).toEqual({status:'unconfirmed',action:'save',actorId:published.actor_id,orderId:fixture.orderId,key:published.key});
   }finally{await other.context.close();}
   const stranger=await h.dedicated('worker','TEST unrelated receipt reader '+randomUUID()),denied=await h.open(stranger.id,1165,{},'/ui/digital-production?instruction='+fixture.orderId);
   try{const rejected=await denied.page.request.get(h.base+path+'/save-receipt?key='+key);expect([403,404]).toContain(rejected.status());expect(await rejected.text()).not.toContain(receipt.payloadHash);}finally{await denied.context.close();}
   expect(await snapshot()).toEqual(before);
  }finally{await tab.context.close();}
 });
 it('keeps a real original decision receipt readable after approval is revoked in the same authenticated session, and denies it after object read is revoked',async()=>{
  const f=h.f,manager=await h.dedicated('owner_group','TEST dedicated original PO approver '+randomUUID());
  const technical=await f.access.assignRole(h.admin,{userId:manager.id,roleCode:'pmc',reason:'TEST retain original technical read after approval revoked'});
  await f.access.assignRole(h.admin,{userId:manager.id,roleCode:'finance_read',reason:'TEST retain authenticated identity after object access revoked'});
  const fixture=await prepare(),requested=await f.runtime.run(fixture.scene,f.root,()=>fixture.service.requestDate(f.root,fixture.orderId,{orderVersion:fixture.before.currentOrderVersion,changes:fixture.before.customerPoDates!.map(row=>({lineId:row.lineId,expectedVersion:row.version,date:'2027-03-06'})),reason:'TEST original approver current read only receipt'},randomUUID()));
  const original=requested.dateRequests.find(row=>row.reason==='TEST original approver current read only receipt')!,path=`/api/digital-production/orders/${fixture.orderId}/instruction/date-requests/${original.requestId}/decision`,key=randomUUID(),tab=await h.open(manager.id,1165,{},'/ui/digital-production?instruction='+fixture.orderId);
  try{
   const page=tab.page;await page.locator('#instruction-styleName').waitFor();await notices(page);
   const decision=await page.request.post(h.base+path,{headers:{'idempotency-key':key},data:{approved:false}});expect(decision.status(),await decision.text()).toBe(200);
   await f.access.revokeRole(h.admin,manager.assignmentId,'TEST revoke only approval authority, original read remains');
   const me=await page.request.get(h.base+'/api/auth/me');expect(me.status()).toBe(200);expect((await me.json()).user.businessRoles).not.toContain('owner_group');
   const sheet=await page.request.get(h.base+`/api/digital-production/orders/${fixture.orderId}/instruction`);expect(sheet.status()).toBe(200);expect((await sheet.json()).canApproveDate).toBe(false);
   const snapshot=async()=>(await h.db.query(`SELECT (SELECT count(*)::int FROM digital_po_customer_decisions WHERE request_id=$1) AS decisions,(SELECT count(*)::int FROM digital_production_commands WHERE actor_id=$2 AND command=$3) AS commands,(SELECT count(*)::int FROM audit_events WHERE entity_id=$4::text) AS audit`,[original.requestId,manager.id,`po-customer:${fixture.orderId}:decision`,fixture.orderId])).rows[0];
   const before=await snapshot(),read=await page.request.get(h.base+path+'-receipt?key='+key+'&approved=false');expect(read.status()).toBe(200);const receipt=await read.json();expect(receipt).toMatchObject({status:'completed',actorId:manager.id,orderId:fixture.orderId,requestId:original.requestId,approved:false,key});expect(Object.keys(receipt).sort()).toEqual(['status','action','actorId','orderId','requestId','approved','key','payloadHash'].sort());
   const refused=await page.request.post(h.base+path,{headers:{'idempotency-key':randomUUID()},data:{approved:false}});expect(refused.status()).toBe(403);expect(await snapshot()).toEqual(before);
   await f.access.revokeRole(h.admin,technical.assignmentId,'TEST revoke original object read, retain login');expect((await page.request.get(h.base+'/api/auth/me')).status()).toBe(200);
   const denied=await page.request.get(h.base+path+'-receipt?key='+key+'&approved=false');expect([403,404]).toContain(denied.status());expect(await denied.text()).not.toContain(receipt.payloadHash);expect(await snapshot()).toEqual(before);
  }catch(error){await writeFile(join(h.evidence,'same-session-decision-receipt-permissions-failure.txt'),await tab.page.locator('body').innerText());throw error;}finally{await tab.context.close();}
 });
});
