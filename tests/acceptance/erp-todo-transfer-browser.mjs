import assert from 'node:assert/strict';
import {build} from 'vite';
import {mkdtemp,readFile,readdir,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer} from 'node:http';
const {chromium}=await import(process.env.PLAYWRIGHT_IMPORT||'playwright');
const output=await mkdtemp(join(tmpdir(),'dx-todo-transfer-')),directory=process.env.TODO_TRANSFER_EVIDENCE,results=[],errors=[],external=[];
const cases=['success','root','wrong-role','forbidden','conflict','unknown','unknown-gone','invalid-json','viewer','role-forbidden','other-manager','read-failure','empty-candidates','inactive-recipient','identity-change'];
let browser,server,deadline;
try{
 await build({configFile:false,esbuild:{jsx:'automatic'},define:{'import.meta.env.BASE_URL':'"/"','process.env.NODE_ENV':'"production"'},build:{outDir:output,lib:{entry:resolve('tests/fixtures/erp-todo-transfer.tsx'),name:'TodoTransfer',formats:['iife']}}});
 const names=await readdir(output),js=await readFile(join(output,names.find(n=>n.endsWith('.js'))),'utf8'),css=await readFile(join(output,names.find(n=>n.endsWith('.css'))),'utf8');const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script>${js.replace(/<\/script/gi,'<\\/script')}</script></html>`;
 server=createServer((_request,response)=>{response.setHeader('content-type','text/html;charset=utf-8');response.end(html);});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});if(directory)await mkdir(directory,{recursive:true});
 for(const viewport of [{width:1440,height:900},{width:375,height:812}])for(const name of cases){
  if(process.env.TODO_TRANSFER_ONLY_CASE&&name!==process.env.TODO_TRANSFER_ONLY_CASE)continue;
  const key=`${name}-${viewport.width}`;console.log('START '+key);deadline=setTimeout(()=>void browser.close(),30000);const page=await browser.newPage({viewport}),navigations=[];page.on('framenavigated',frame=>{if(frame===page.mainFrame())if(navigations.length<12)navigations.push(frame.url());});page.on('pageerror',e=>errors.push({key,message:e.message}));
  try{
   await page.route('**/*',route=>{if(route.request().isNavigationRequest()&&new URL(route.request().url()).hostname==='127.0.0.1')return route.continue();external.push(route.request().url());return route.abort();});await page.addInitScript(value=>sessionStorage.setItem('dx-erp:todo-test-scenario',value),name==='wrong-role'?'success':name);await page.goto(`http://127.0.0.1:${server.address().port}/ui/my-tasks?module=rework`);await page.getByRole('heading',{name:'待办接手安排',exact:true}).waitFor({timeout:10000});
   const requests=()=>page.evaluate(()=>window.todoTransferFixture.requests),posts=async()=>(await requests()).filter(r=>r.method==='POST'&&r.path.includes('/todos/routing-exceptions/'));
   if(['viewer','role-forbidden'].includes(name)){assert.equal(await page.locator('.todo-routing-transfer').count(),0);await page.getByText('此项转交由当前指定的管理人办理。',{exact:true}).waitFor();}
   else{
    const details=page.locator('.todo-routing-transfer'),summary=details.locator('summary');await summary.focus();await summary.press('Space');
    if(name==='other-manager'){await page.getByText('这项转交已处理或当前不在你的待处理范围，请刷新待办核对。',{exact:true}).waitFor();assert.equal(await details.locator('form').count(),0);}
    else{
     if(name==='read-failure'){await details.getByRole('alert').waitFor();await page.getByRole('button',{name:'重读转交事项与人员',exact:true}).click();}
     await details.locator('form').waitFor();const choose=async text=>{const input=details.getByRole('combobox');await input.fill(text);await input.press('ArrowDown');await input.press('Enter');await input.press('Escape');};
     if(name==='empty-candidates'){await page.getByText('当前名单中暂无可选人员，请核对人员任职情况。',{exact:true}).waitFor();assert.equal(await details.getByRole('button',{name:'确认转交此项任务',exact:true}).isDisabled(),true);}
     else{
      await choose(name==='wrong-role'?'TEST 跟单':'TEST 王师傅');const note='TEST 原接收人已离职，按现有岗位安排接手。';await details.locator('textarea').fill(note);
      if(name==='identity-change'){await page.evaluate(()=>{window.todoTransferFixture.identityChanged=true;window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}));});await page.getByText('您当前的任务已全部完成。有新的事项轮到你处理时，会出现在这里。',{exact:true}).waitFor();assert.equal((await posts()).length,0);assert.equal(await page.locator('.todo-routing-transfer form').count(),0);results.push({key,scenario:name,viewport,requests:await requests(),writeCount:0});continue;}
      // Two native form submissions exercise the same actual handler before the response.
      await details.locator('form').evaluate(form=>{form.requestSubmit();form.requestSubmit();});
      if(['unknown','unknown-gone','invalid-json'].includes(name)){
       await details.getByRole('alert').filter({hasText:'提交结果尚未确认'}).waitFor();assert.equal((await posts()).length,1);await page.getByRole('button',{name:'重新读取转交事项',exact:true}).click();await page.getByText(name==='unknown-gone'?'这项转交已不在待处理列表，请从原单核对当前接手结果。':'这项转交仍在待处理列表，提交结果尚未确认，暂不重复提交。',{exact:true}).waitFor();
       await summary.focus();await summary.press('Space');await summary.press('Space');assert.equal(await details.locator('form').count(),0);assert.equal((await posts()).length,1);assert.doesNotMatch(await details.innerText(),/已转交给/);
      }else if(['forbidden','wrong-role','conflict','inactive-recipient'].includes(name)){
       await details.getByRole('alert').waitFor();assert.equal(await details.locator('textarea').inputValue(),note);assert.equal(await details.locator('select').inputValue(),name==='wrong-role'?'00000000-0000-4000-8000-000000000301':'00000000-0000-4000-8000-000000000300');assert.doesNotMatch(await details.innerText(),/New recipient|routing exception|FORBIDDEN/);assert.equal((await posts()).length,1);
       if(name==='wrong-role'){await choose('TEST 王师傅');await details.getByRole('button',{name:'确认转交此项任务',exact:true}).click();await page.getByText('您当前的任务已全部完成。有新的事项轮到你处理时，会出现在这里。',{exact:true}).waitFor();assert.equal((await posts()).length,2);}
      }else{await page.getByText('您当前的任务已全部完成。有新的事项轮到你处理时，会出现在这里。',{exact:true}).waitFor();assert.equal((await posts()).length,1);}
      const first=(await posts())[0];assert.equal(first.path,'/api/todos/routing-exceptions/00000000-0000-4000-8000-000000000018/transfer');assert.equal(first.body.reason,note);assert.ok(!('delegationId'in first.body),'does not invent a delegation');
     }
    }
   }
   const all=await requests();assert.ok(all.filter(r=>r.method!=='GET').every(r=>r.path.includes('/todos/routing-exceptions/')||r.path.includes('/digital-production/notifications/claim')),'no unrelated business commands');assert.equal(all.filter(r=>r.path.includes('/todos/mine/00000000-0000-4000-8000-000000000012')).length,0,'never reads the former recipients todo');if(['viewer','role-forbidden'].includes(name))assert.equal(all.filter(r=>r.path.includes('/routing-exceptions/')||r.path.includes('/access/candidates')).length,0,'no ungranted reads');
   const width=await page.evaluate(()=>document.documentElement.scrollWidth);assert.ok(width<=viewport.width+1,key+' no page overflow');if(directory)await page.screenshot({path:join(directory,key+'.png'),fullPage:true});results.push({key,scenario:name,viewport,requests:all,writeCount:(await posts()).length,width});
  }catch(error){console.log(JSON.stringify({key,navigations,errors}));if(directory&&!page.isClosed()){try{await writeFile(join(directory,key+'-failure.txt'),await page.locator('body').innerText({timeout:2000}));await writeFile(join(directory,key+'-requests.json'),JSON.stringify(await page.evaluate(()=>window.todoTransferFixture?.requests??[]),null,2));await page.screenshot({path:join(directory,key+'-failure.png'),timeout:3000});}catch{/* Keep original failure. */}}throw error;}finally{clearTimeout(deadline);await page.close();}console.log('DONE '+key);
 }
 assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
}finally{clearTimeout(deadline);if(directory)await writeFile(join(directory,'result.json'),JSON.stringify({results,errors,external,limits:['Actual App/MyTodosPage and client handler with intercepted synthetic APIs; not server authorization proof.','Only intercepted transfer writes; no real todo,recipient or production/Acceptance data.','Original service allowed/denied eligibility must be covered separately with isolated database/API tests.']},null,2));await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));await rm(output,{recursive:true,force:true});}
console.log(JSON.stringify({frames:results.length,errors,external}));
