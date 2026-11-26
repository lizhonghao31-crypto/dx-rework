import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {chromium} from 'playwright-core';
import {build} from 'vite';

const base=process.env.G7_BASE_SHA;
assert.match(base??'',/^[a-f0-9]{40}$/,'Use the actual release base');
const workspacePath='apps/web/src/digital-pattern-workspace.tsx',workspace=resolve(workspacePath);
const source=execFileSync('git',['show',`${base}:${workspacePath}`],{encoding:'utf8'});
const output=await mkdtemp(join(tmpdir(),'dx-g7-board-'));
const results={},errors=[];
let browser,server;

async function render(useBase){
 const outDir=join(output,useBase?'base':'candidate');
 await build({configFile:false,logLevel:'error',plugins:useBase?[{name:'g7-release-base',load(file){if(file===workspace)return source;}}]:[],
  esbuild:{jsx:'automatic'},define:{'import.meta.env.BASE_URL':'"/"','process.env.NODE_ENV':'"production"'},
  build:{outDir,lib:{entry:resolve('tests/fixtures/digital-read-recovery.tsx'),name:'G7Board',formats:['iife']}}});
 const files=await readdir(outDir),js=await readFile(join(outDir,files.find(file=>file.endsWith('.js'))),'utf8'),css=await readFile(join(outDir,files.find(file=>file.endsWith('.css'))),'utf8');
 return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script>${js.replace(/<\/script/gi,'<\\/script')}</script></html>`;
}

try{
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH??'/usr/bin/chromium',args:['--no-sandbox']});
 for(const isBase of [true,false]){
  const html=await render(isBase);
  server=createServer((_request,response)=>response.writeHead(200,{'content-type':'text/html;charset=utf-8'}).end(html));
  await new Promise(done=>server.listen(0,'127.0.0.1',done));
  const origin=`http://127.0.0.1:${server.address().port}`;
  const page=await browser.newPage({viewport:{width:1440,height:900}});
  page.on('pageerror',error=>errors.push(error.message));
  page.setDefaultTimeout(5000);
  const visits=[],table=page.locator('.pattern-task-list');
  const globalEmpty=()=>table.getByText('当前筛选暂无真实任务',{exact:true});
  const localEmpty=()=>table.locator('.pattern-lane-cards p');
  const visit=async(search,query='scope=mine')=>{
   await page.goto(origin+'/ui/digital-pattern-room?search='+search+'&'+query);
   await table.getByRole('heading',{name:'岗位进度看板',exact:true}).waitFor();
   await page.waitForFunction(()=>!document.querySelector('.pattern-task-list')?.innerText.includes('正在读取授权任务'));
   return search;
  };
  const record=async(name)=>{
   const requests=await page.evaluate(()=>window.readRecoveryFixture.requests);
   assert.equal(requests.filter(request=>request.method!=='GET').length,0);
   assert.deepEqual(await page.evaluate(()=>window.readRecoveryFixture.unexpected),[]);
   visits.push({name,requests});
  };
  await visit('g7-empty');
  assert.equal(await globalEmpty().count(),1);
  assert.equal(await localEmpty().count(),isBase?7:0);
  assert.equal(await table.getByRole('button',{name:'查看全部',exact:true}).count(),7);
  await record('confirmed zero');
  await visit('g7-unknown');
  assert.equal(await globalEmpty().count(),isBase?1:0);
  assert.match(await table.locator('.pattern-board-title').innerText(),/— 项任务/);
  if(!isBase)assert.deepEqual(await localEmpty().allTextContents(),Array(7).fill('本页无此环节任务'));
  await record('unknown total');
  await visit('g7-other-page','scope=all&lane=pattern&page=3');
  assert.equal(await globalEmpty().count(),isBase?1:0);
  assert.equal(await localEmpty().innerText(),'本页无此环节任务');
  assert.match(await table.locator('.pattern-board-title').innerText(),/16 项任务/);
  await record('another page has tasks');
  await visit('g7-other-lane','scope=all&lane=pattern');
  assert.equal(await globalEmpty().count(),isBase?1:0);
  assert.equal(await table.locator('.pattern-board-column').count(),1);
  assert.match(await page.locator('.pattern-group-cards').innerText(),/派工与车板\s*2/);
  await record('another lane has tasks');
  for(const [scenario,message]of [['g7-freshness','部分订单信息尚未更新'],['g7-detail-failure','TEST G7 原任务 的详情读取失败'],['g7-read-failure','TEST 服务读取失败']]){
   await visit(scenario);
   await page.getByText(message,{exact:false}).first().waitFor();
   assert.equal(await globalEmpty().count(),0);
   assert.equal(await localEmpty().count(),0);
   await record(scenario);
  }
  await visit('g7-empty');
  const keyword=page.getByRole('textbox',{name:'关键词',exact:true});
  await keyword.fill('g7-late-empty');
  if(!isBase)assert.equal(await globalEmpty().count(),0);
  await page.waitForFunction(()=>Boolean(window.readRecoveryFixture.releaseSlow));
  await keyword.fill('g7-preview');
  await table.locator('.pattern-task-card').waitFor();
  await page.evaluate(()=>window.readRecoveryFixture.releaseSlow());
  await page.waitForFunction(()=>window.readRecoveryFixture.slowSettled);
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  assert.equal(await globalEmpty().count(),isBase?1:0);
  assert.match(await table.locator('.pattern-task-card').innerText(),/TEST G7 纸样任务[\s\S]*第 2 轮[\s\S]*TEST 主办人[\s\S]*做纸样/);
  await record('obsolete empty request after fresh card');
  for(const [scope,action,view]of [['mine','做纸样',null],['all','查看任务','read']]){
   await visit('g7-preview','scope='+scope);
   const card=table.getByRole('button',{name:new RegExp(action)});
   await card.waitFor();
   assert.equal(await globalEmpty().count(),isBase?1:0);
   await record('preview only '+scope);
   const from=new URL(page.url());
   await card.focus();await page.keyboard.press('Enter');
   await page.waitForURL(url=>url.pathname==='/ui/digital-production');
   const target=new URL(page.url());
   assert.equal(target.searchParams.get('task'),'00000000-0000-4000-8000-000000000001');
   assert.equal(target.searchParams.get('taskView'),view);
   assert.equal(target.searchParams.get('returnTo'),from.pathname+from.search);
   await page.goBack();
   await card.waitFor();
   assert.equal(new URL(page.url()).search,from.search);
   await record('same original route and source '+scope);
  }
  await page.close();
  await new Promise(done=>server.close(done));server=null;
  results[isBase?'base':'candidate']=visits;
 }
 assert.deepEqual(results.candidate,results.base);
 assert.deepEqual(errors,[]);
 const evidence={base,checks:results,candidateConfirmedEmptyBanner:1,candidateConfirmedEmptyLaneMessages:0,errors,
  limitation:'Actual local DigitalPatternWorkspace and browser navigation with synthetic authorized response fixtures. Deployed Acceptance is separate.'};
 if(process.env.G7_BROWSER_EVIDENCE)await writeFile(process.env.G7_BROWSER_EVIDENCE,JSON.stringify(evidence,null,2)+'\n');
 console.log(JSON.stringify({passed:results.candidate.length,sameRequests:true,writes:0,errors}));
}finally{
 await browser?.close();
 if(server)await new Promise(done=>server.close(done));
 await rm(output,{recursive:true,force:true});
}
