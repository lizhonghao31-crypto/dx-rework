import assert from 'node:assert/strict';
import {build} from 'vite';
import {mkdtemp,readFile,readdir,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer} from 'node:http';
const {chromium}=await import(process.env.PLAYWRIGHT_IMPORT||'playwright');
const out=await mkdtemp(join(tmpdir(),'dx-material-')),evidence=process.env.PLATFORM_EVIDENCE,results=[],errors=[];
let browser,server,activePage;
try{
 await build({configFile:false,esbuild:{jsx:'automatic',jsxDev:false},define:{'import.meta.env.BASE_URL':'"/"','process.env.NODE_ENV':'"production"'},build:{outDir:out,lib:{entry:resolve('tests/fixtures/platform-feedback.tsx'),name:'MaterialClosure',formats:['iife']}}});
 const names=await readdir(out),js=await readFile(join(out,names.find(n=>n.endsWith('.js'))),'utf8'),css=await readFile(join(out,names.find(n=>n.endsWith('.css'))),'utf8');
 const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script>${js.replace(/<\/script/gi,'<\\/script')}</script></html>`;
 server=createServer((_req,res)=>{res.setHeader('content-type','text/html;charset=utf-8');res.end(html);});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});if(evidence)await mkdir(evidence,{recursive:true});
 const scenarios=[...['503','malformed','network','401','no-role'].map(mode=>['auth',mode]),...['fail','empty','saved-read-fail','lost'].map(mode=>['employee',mode]),...['fail','empty'].map(mode=>['workforce',mode]),...['lost','malformed','denied','expired'].map(mode=>['prices',mode]),...['lost','malformed','denied','expired'].map(mode=>['template',mode]),...['fail','malformed','empty'].map(mode=>['admin',mode]),['acceptance','fail'],['acceptance-preview','fail']];
 for(const width of [1440,390])for(const [view,mode] of scenarios){
  if(process.env.PLATFORM_CASES&&!process.env.PLATFORM_CASES.split(',').includes(view+':'+mode))continue;
  console.log(JSON.stringify({view,mode,width}));
  const context=await browser.newContext({viewport:{width,height:1000}}),page=await context.newPage();activePage=page;page.on('pageerror',e=>errors.push(e.message));
  const route=({employee:'/ui/employee-access',workforce:'/ui/workforce',prices:'/ui/pattern-room/prices',template:'/ui/contract-template',admin:'/ui/admin',acceptance:'/ui/acceptance','acceptance-preview':'/ui/acceptance/command-center'})[view]??'/';
  await page.goto(`http://127.0.0.1:${server.address().port}${route}?view=${view}&mode=${mode}`);const writes=()=>page.evaluate(()=>window.platformFeedbackFixture.requests.filter(r=>r.method!=='GET'));
  if(view==='auth'){
   if(mode==='no-role')await page.getByRole('heading',{name:'尚未分配业务角色',exact:true}).waitFor();
   else if(mode==='401'){await page.getByText('TEST受保护业务',{exact:true}).waitFor({state:'detached'});assert.equal(await page.getByRole('heading',{name:'当前身份尚未读取',exact:true}).count(),0);}
   else{await page.getByRole('heading',{name:'当前身份尚未读取',exact:true}).waitFor();assert.equal(await page.getByText('TEST受保护业务',{exact:true}).count(),0);assert.equal(await page.evaluate(()=>window.platformFeedbackFixture.requests.some(r=>/client-config|qr-start/.test(r.path))),false);await page.getByRole('button',{name:'重新读取登录状态',exact:true}).click();await page.getByText('TEST受保护业务',{exact:true}).waitFor();}
  }else if(view==='employee'){
   if(mode==='fail'){await page.getByText(/员工目录尚未读取/).waitFor();assert.equal(await page.getByText('没有匹配的员工。',{exact:true}).count(),0);await page.getByRole('button',{name:'仅重新读取员工目录',exact:true}).click();await page.getByText('TEST员工',{exact:true}).waitFor();}
   else if(mode==='empty')await page.getByText('没有匹配的员工。',{exact:true}).waitFor();
   else{await page.getByPlaceholder('例如：岗位调整；留空点击操作时会提示填写').fill('TEST只核对原权限反馈');await page.getByRole('button',{name:'停用访问',exact:true}).click();await page.getByRole('button',{name:'确认',exact:true}).click();
    if(mode==='saved-read-fail')await page.getByText(/修改已保存，最新员工权限资料尚未读取/).waitFor();else await page.getByText(/原权限操作结果尚未确认/).waitFor();
    const before=(await writes()).length;await page.getByRole('button',{name:'仅重新读取员工目录',exact:true}).click();await page.getByRole('button',{name:'恢复访问',exact:true}).waitFor();assert.equal((await writes()).length,before);assert.equal(await page.getByRole('button',{name:'恢复访问',exact:true}).isDisabled(),mode==='lost');
   }
  }else if(view==='workforce'){
   if(mode==='fail'){await page.getByText('内部工人目录尚未读取。',{exact:true}).waitFor();assert.equal(await page.getByText('暂无临时工档案。',{exact:true}).count(),0);await page.getByRole('button',{name:'仅重新读取人员目录',exact:true}).click();}
   await page.getByText('暂无临时工档案。',{exact:true}).waitFor();
  }else if(view==='prices'||view==='template'){
   if(view==='prices'){await page.getByRole('button',{name:'调整',exact:true}).click();await page.getByLabel(/新单价/).fill('12');await page.getByLabel('调整原因（必填）',{exact:true}).fill('TEST价格反馈');await page.getByRole('button',{name:'保存',exact:true}).click();}
   else{await page.getByLabel(/模板名称/).fill('TEST反馈新模板');await page.getByRole('button',{name:'生成预览',exact:true}).click();await page.getByRole('link',{name:'查看合同预览',exact:true}).waitFor();await page.getByRole('button',{name:'保存生效',exact:true}).click();}
   if(mode==='denied')await page.getByText('TEST原有权岗位才可办理，请核对原权限',{exact:true}).waitFor();
   else{const recovery=page.getByRole('button',{name:view==='prices'?'使用原内容核对价格调整':'使用原内容核对模板保存',exact:true});await recovery.waitFor();const before=(await writes()).length;
    if(mode==='expired'){await page.evaluate(()=>window.platformFeedbackFixture.advance());await recovery.click();await page.getByText(/已超过安全恢复期限/).waitFor();assert.equal((await writes()).length,before);}
    else{await recovery.click();await recovery.waitFor({state:'detached'});const records=await writes();assert.deepEqual(records.at(-1),records.at(-2));assert.equal(await page.evaluate(()=>window.platformFeedbackFixture.commits),1);}
   }
  }else if(view==='admin'){
   if(mode!=='empty'){await page.getByRole('alert').first().waitFor();assert.equal(await page.getByText(/没有审计记录/).count(),0);}
   else await page.getByText(/没有|暂无/).first().waitFor();
  }else if(view==='acceptance'){
   await page.getByText(/不能据此判断凭证失效/).waitFor();assert.equal((await writes()).length,0);await page.getByRole('button',{name:'仅重新读取验收状态',exact:true}).click();await page.getByRole('button',{name:'仅重新读取验收状态',exact:true}).waitFor({state:'detached'});assert.equal((await writes()).length,0);
  }else{await page.getByText(/验收环境状态尚未读取/).waitFor();await page.getByRole('button',{name:'仅重新读取验收状态',exact:true}).click();await page.locator('[data-acceptance-command-center-ready]').waitFor();assert.equal((await writes()).length,0);}
  assert.equal(await page.evaluate(()=>window.platformFeedbackFixture.requests.some(r=>r.method!=='GET'&&(/acceptance|directory\/sync/.test(r.path)))),false);
  if(evidence)await page.screenshot({path:join(evidence,`${view}-${mode}-${width}.png`),fullPage:true});results.push({width,view,mode,passed:true});await context.close();
 }
 assert.deepEqual(errors,[]);
}catch(error){if(evidence&&activePage)await activePage.screenshot({path:join(evidence,'failure.png'),fullPage:true}).catch(()=>undefined);throw error;}finally{if(evidence)await writeFile(join(evidence,'result.json'),JSON.stringify({results,errors,limits:['Actual components with synthetic TEST responses; API/transactions/notifications verified separately in isolated PostgreSQL. No real orders or deployment.']},null,2));await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));await rm(out,{recursive:true,force:true});}
console.log(JSON.stringify({frames:results.length,errors}));
