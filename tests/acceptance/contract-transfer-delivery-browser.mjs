import assert from 'node:assert/strict';
import { build } from 'vite';
import { mkdtemp, readFile, readdir, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
const { chromium }=await import(process.env.PLAYWRIGHT_IMPORT || 'playwright');
const output=await mkdtemp(join(tmpdir(),'dx-contract-ui-')),evidence=process.env.CONTRACT_UI_EVIDENCE_DIR;
const results=[];let browser,server;
try{
  if(evidence)await mkdir(evidence,{recursive:true});
  await build({configFile:false,esbuild:{jsx:'automatic'},define:{'import.meta.env.BASE_URL':'"/"','process.env.NODE_ENV':'"production"'},
    build:{outDir:output,lib:{entry:resolve('tests/fixtures/contract-transfer-delivery.tsx'),name:'ContractTransfer',formats:['iife']}}});
  const files=await readdir(output),js=await readFile(join(output,files.find(n=>n.endsWith('.js'))),'utf8'),css=await readFile(join(output,files.find(n=>n.endsWith('.css'))),'utf8');
  const html='<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>'+css+'</style><div id="root"></div><script>'+js.replace(/<\/script/gi,'<\\/script')+'</script></html>';
  server=createServer((_request,response)=>{response.setHeader('content-type','text/html;charset=utf-8');response.end(html);});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});
  const origin='http://127.0.0.1:'+server.address().port;
  for(const width of [390,1440])for(const role of ['root','management','merchandiser','owner']){
    const page=await browser.newPage({viewport:{width,height:960}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(origin+'/?role='+role);
    try{await page.locator('.sourcing-contract-bar').waitFor({timeout:10000});}catch(error){console.log(JSON.stringify({role,errors,body:(await page.locator('body').innerText()).slice(0,1800)}));throw error;}
    assert.equal(await page.getByText('可一次传两个，也可分次追加；累计最多 2 个 PDF/JPG/PNG，合计不超过 20 MB',{exact:true}).count(),0);
    assert.equal(await page.getByRole('button',{name:'补传回签合同',exact:true}).count(),1);
    await page.getByText('本版本 V7 无回签记录',{exact:true}).waitFor();
    assert.equal(await page.getByRole('link',{name:'查看 V6 回签合同',exact:true}).count(),1);
    if(role==='root'&&evidence)await page.locator('.sourcing-contract-bar').screenshot({path:join(evidence,'contract-'+width+'.png')});
    await page.getByRole('button',{name:'订单转厂',exact:true}).click();
    const allowed=role==='root'||role==='management',toggle=page.getByRole('checkbox',{name:'修改交货日期',exact:true});
    assert.equal(await toggle.count(),allowed?1:0);
    await page.locator('.sourcing-factory-change select').selectOption('00000000-0000-4000-8000-000000000005');
    await page.getByLabel('新加工单价',{exact:true}).fill('15.5');
    await page.getByLabel('转厂原因',{exact:true}).fill('TEST-browser-transfer');
    if(allowed){
      assert.equal(await toggle.isChecked(),false);
      await toggle.check();const date=page.getByLabel('转厂后交货日期',{exact:true});
      assert.equal(await date.inputValue(),'2026-10-22');
      await date.fill('2026-10-03');assert.equal(await page.getByRole('button',{name:'提交转厂',exact:true}).isDisabled(),true);
      await date.fill('2026-10-30');assert.equal(await page.getByRole('button',{name:'提交转厂',exact:true}).isDisabled(),false);
    }
    if(evidence)await page.getByRole('region',{name:'订单转厂',exact:true}).screenshot({path:join(evidence,'transfer-'+role+'-'+width+'.png')});
    assert.equal(await page.evaluate(()=>document.body.scrollWidth>innerWidth),false);
    await page.getByRole('button',{name:'提交转厂',exact:true}).click();
    await page.waitForFunction(()=>window.contractTransferRequests.some(r=>r.method==='POST'));
    const writes=await page.evaluate(()=>window.contractTransferRequests.filter(r=>r.method==='POST'));
    assert.equal(writes.length,1);
    if(allowed)assert.equal(writes[0].body.deliveryDate,'2026-10-30');else assert.equal(Object.hasOwn(writes[0].body,'deliveryDate'),false);
    assert.deepEqual(errors,[]);results.push({width,role,dateAllowed:allowed,uploadAndHistoryRetained:true,noHorizontalOverflow:true,passed:true});await page.close();
  }
  for(const width of [390,1440]){
    const page=await browser.newPage({viewport:{width,height:844}}),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto(origin+'/?role=root&transferFailure=1');
    await page.locator('.sourcing-contract-bar').waitFor();
    const panel=page.getByRole('region',{name:'订单转厂',exact:true});
    await panel.getByRole('button',{name:'订单转厂',exact:true}).click();
    await panel.locator('select').selectOption('00000000-0000-4000-8000-000000000005');
    await panel.getByLabel('新加工单价',{exact:true}).fill('11.3');
    await panel.getByLabel('转厂原因',{exact:true}).fill('TEST-保留转厂填写内容');
    await panel.getByRole('checkbox',{name:'修改交货日期',exact:true}).check();
    await panel.getByLabel('转厂后交货日期',{exact:true}).fill('2026-10-30');
    const submit=panel.getByRole('button',{name:'提交转厂',exact:true});
    const price=await panel.getByLabel('新加工单价',{exact:true}).inputValue();
    await submit.click();
    await page.waitForFunction(()=>typeof window.releaseTransferFailure==='function');
    assert.equal(await submit.isDisabled(),true);
    assert.equal((await page.evaluate(()=>window.contractTransferRequests.filter(row=>row.method==='POST'))).length,1);
    await page.evaluate(()=>window.releaseTransferFailure());
    const failure=panel.getByRole('alert');
    await failure.waitFor({state:'visible'});
    assert.match(await failure.innerText(),/TEST-转厂数量与当前订单数量不一致/);
    assert.match(await failure.innerText(),/请求编号：TEST-transfer-conflict-1/);
    assert.equal(await submit.isDisabled(),false);
    assert.equal(await panel.locator('select').inputValue(),'00000000-0000-4000-8000-000000000005');
    assert.equal(await panel.getByLabel('新加工单价',{exact:true}).inputValue(),price);
    assert.equal(await panel.getByLabel('转厂原因',{exact:true}).inputValue(),'TEST-保留转厂填写内容');
    assert.equal(await panel.getByLabel('转厂后交货日期',{exact:true}).inputValue(),'2026-10-30');
    await page.waitForFunction(()=>{
      const alert=document.querySelector('.sourcing-factory-change [role="alert"]');
      if(!alert)return false;
      const box=alert.getBoundingClientRect();
      return document.activeElement===alert&&box.top>=0&&box.bottom<=innerHeight+1;
    });
    const failureBox=await failure.boundingBox(),submitBox=await submit.boundingBox();
    assert.ok(failureBox&&submitBox&&failureBox.y-(submitBox.y+submitBox.height)>=0
      &&failureBox.y-(submitBox.y+submitBox.height)<80);
    assert.equal(await page.evaluate(()=>document.body.scrollWidth>innerWidth),false);
    if(evidence)await panel.screenshot({path:join(evidence,'transfer-failure-'+width+'.png')});
    await page.evaluate(()=>window.showTransferFixtureCase(101));
    await page.locator('a.sourcing-workflow-step[href*="00000000-0000-4000-8000-000000000101"]').first().waitFor({state:'attached'});
    assert.equal(await panel.getByRole('alert').count(),0);
    await page.evaluate(()=>window.showTransferFixtureCase(100));
    await page.locator('a.sourcing-workflow-step[href*="00000000-0000-4000-8000-000000000100"]').first().waitFor({state:'attached'});
    await submit.click();
    await panel.getByRole('status').filter({hasText:'老板发起的转厂已直接生效'}).waitFor();
    assert.equal(await panel.getByRole('alert').count(),0);
    const writes=await page.evaluate(()=>window.contractTransferRequests.filter(row=>row.method==='POST'));
    assert.equal(writes.length,2);assert.ok(writes[0].key);assert.equal(writes[0].key,writes[1].key);
    assert.deepEqual(writes[0].body,writes[1].body);
    assert.equal(await panel.getByLabel('转厂原因',{exact:true}).inputValue(),'');
    await panel.getByRole('button',{name:'订单转厂',exact:true}).click();
    await panel.getByRole('button',{name:'订单转厂',exact:true}).click();
    assert.equal(await panel.locator('.sourcing-action-message').count(),0);
    assert.deepEqual(errors,[]);
    results.push({width,transferConflictVisibleNearSubmit:true,inputRetained:true,busyReset:true,
      requestIdVisible:true,caseScopedFeedback:true,retryKeyRetained:true,successSurvivesReload:true,passed:true});
    await page.close();
  }
  {
    const page=await browser.newPage({viewport:{width:1440,height:900}}),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto(origin+'/?role=root&transferRefreshFailure=1');
    await page.locator('.sourcing-contract-bar').waitFor();
    const panel=page.getByRole('region',{name:'订单转厂',exact:true});
    await panel.getByRole('button',{name:'订单转厂',exact:true}).click();
    await panel.locator('select').selectOption('00000000-0000-4000-8000-000000000005');
    await panel.getByLabel('新加工单价',{exact:true}).fill('11.3');
    await panel.getByLabel('转厂原因',{exact:true}).fill('TEST-提交已成功但读取刷新失败');
    await panel.getByRole('button',{name:'提交转厂',exact:true}).click();
    await page.getByText('TEST-订单页面刷新失败',{exact:true}).waitFor();
    assert.equal(await panel.getByRole('status').innerText(),'老板发起的转厂已直接生效');
    assert.equal(await panel.getByRole('alert').count(),0);
    assert.equal(await panel.locator('select').inputValue(),'');
    assert.equal(await panel.getByLabel('转厂原因',{exact:true}).inputValue(),'');
    const requests=await page.evaluate(()=>window.contractTransferRequests);
    assert.equal(requests.filter(row=>row.method==='POST').length,1);
    assert.ok(requests.filter(row=>row.method==='GET'&&row.path.endsWith('/timeline')).length>=2);
    assert.deepEqual(errors,[]);
    results.push({transferCommitted:true,refreshFailed:true,successRetained:true,noFalseSubmissionError:true,noAutomaticResubmit:true,passed:true});
    await page.close();
  }
  for(const reviewed of [false,true]){
    const page=await browser.newPage({viewport:{width:1440,height:960}});
    await page.goto(origin+'/?role=root&reviewed='+(reviewed?'1':'0'));await page.getByRole('button',{name:'更新合同信息',exact:true}).click();
    assert.equal(await page.getByRole('button',{name:'修改合同内容',exact:true}).count(),reviewed?0:1);
    await page.getByRole('button',{name:'更新供应商以及合同信息',exact:true}).click();
    await page.getByText('供应商资料及模板与合同一致，无需更新。',{exact:true}).waitFor();
    assert.equal(await page.getByRole('button',{name:'确认更新合同',exact:true}).isDisabled(),true);
    assert.equal((await page.evaluate(()=>window.contractTransferRequests.filter(r=>r.method==='POST'))).length,0);
    results.push({reviewed,rootEditorFollowsVersionFlag:true,refreshPreviewReadOnly:true,passed:true});await page.close();
  }
  for(const [width,height] of [[1440,1024],[1280,800],[768,1024],[390,844],[360,800]]) {
    const page=await browser.newPage({viewport:{width,height}});
    await page.goto(origin+'/?role=management&cycle=1');
    await page.getByText('本版本 V7 无回签记录',{exact:true}).waitFor();
    await page.getByText('本次合同回签时效 · 合同待回签',{exact:true}).click();
    assert.equal(await page.getByRole('button',{name:'上传回签合同',exact:true}).count(),1);
    assert.equal(await page.getByRole('link',{name:'查看 V6 回签合同',exact:true}).count(),1);
    assert.equal(await page.evaluate(()=>document.body.scrollWidth>innerWidth),false);
    if(evidence)await page.locator('.sourcing-contract-bar').screenshot({path:join(evidence,'cycle-'+width+'x'+height+'.png')});
    results.push({width,height,versionCyclePending:true,oldSignaturePreserved:true,noHorizontalOverflow:true,passed:true});await page.close();
  }
  for(const [width,height] of [[1440,1024],[1280,800],[768,1024],[390,844],[360,800]])for(const role of ['management','root']) {
    const page=await browser.newPage({viewport:{width,height}});
    await page.goto(origin+'/?role='+role);const panel=page.getByRole('region',{name:'价格重新申请',exact:true});
    await panel.getByRole('button',{name:'重新申请',exact:true}).click();
    await panel.getByLabel('重新申请单价',{exact:true}).fill('15.25');
    await panel.getByLabel('重新申请原因',{exact:true}).fill('TEST-browser-price-only');
    assert.equal(await panel.locator('input:not([readonly])').count(),2);
    assert.equal(await page.evaluate(()=>document.body.scrollWidth>innerWidth),false);
    await panel.evaluate(element=>element.scrollIntoView({block:'center',behavior:'instant'}));
    if(evidence)await panel.screenshot({path:join(evidence,'price-'+role+'-'+width+'x'+height+'.png')});
    await panel.getByRole('button',{name:'提交价格申请',exact:true}).click();
    await page.waitForFunction(()=>window.contractTransferRequests.some(r=>r.method==='POST'&&r.path.endsWith('/price-reapplications')));
    const writes=await page.evaluate(()=>window.contractTransferRequests.filter(r=>r.method==='POST'&&r.path.endsWith('/price-reapplications')));
    assert.deepEqual(Object.keys(writes[0].body).sort(),['unitPrice','changeReason','expectedDecisionId','expectedContractDocumentId'].sort());
    assert.equal(writes[0].body.unitPrice,'15.25');results.push({width,height,role,priceOnlyPayload:true,noHorizontalOverflow:true,passed:true});await page.close();
  }
  for(const query of ['role=owner','role=merchandiser','role=management&readonly=1']){
    const page=await browser.newPage({viewport:{width:390,height:844}});await page.goto(origin+'/?'+query);await page.locator('.sourcing-contract-bar').waitFor();
    assert.equal(await page.getByRole('button',{name:'重新申请',exact:true}).count(),0);results.push({query,noNewPriceEntry:true,passed:true});await page.close();
  }
  {
    const page=await browser.newPage({viewport:{width:390,height:844}});await page.goto(origin+'/?role=owner&pricePending=1');
    const panel=page.getByRole('region',{name:'价格重新申请',exact:true});await panel.getByLabel('处理说明',{exact:true}).fill('TEST-owner-price-approval');
    await panel.getByRole('button',{name:'批准调价',exact:true}).click();
    await page.waitForFunction(()=>window.contractTransferRequests.some(r=>r.method==='POST'&&r.path.includes('/price-reapplications/')&&r.body.decision==='approved'));
    results.push({ownerExistingApproval:true,noNewOwnerEntry:true,passed:true});await page.close();
  }
  const report={localOnly:true,synthetic:true,noRealBusinessAccess:true,results};
  if(evidence)await writeFile(join(evidence,'browser-result.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
}finally{
  await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));await rm(output,{recursive:true,force:true});
}
