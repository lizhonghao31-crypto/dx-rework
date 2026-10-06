// Read-only comparison against the release-equivalent local baseline.
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {mintAcceptanceLoginCode} from '../../apps/api/src/auth/acceptance-provider.ts';
const {chromium}=await import(process.env.PLAYWRIGHT_IMPORT||'playwright');
const env=JSON.parse(await readFile(process.env.V2_LOCAL_ENV_FILE,'utf8'));
const fixture=JSON.parse(await readFile(process.env.V2_LOCAL_FIXTURE_FILE,'utf8'));
const origin=process.env.V2_CANDIDATE_URL||'http://127.0.0.1:3225';
const baseline=process.env.V2_BASELINE_URL||'http://127.0.0.1:3221';
const out=process.env.V2_REAL_EVIDENCE_DIR;
assert(out);for(const url of [origin,baseline])assert(['127.0.0.1','localhost'].includes(new URL(url).hostname));
await mkdir(out,{recursive:true});
const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true});
const results=[],errors=[];
async function login(url){const context=await browser.newContext({viewport:{width:1672,height:941}});const response=await context.request.post(url+'/api/auth/mobile',{data:{code:mintAcceptanceLoginCode('root',env.ACCEPTANCE_LAB_SECRET)}});assert.equal(response.status(),200);const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));return page;}
async function interior(page){return page.locator('.app-shell > main').evaluate(main=>({text:main.querySelector('.production-dashboard__toolbar time')?main.innerText.replace(main.querySelector('.production-dashboard__toolbar time').innerText,'数据快照读取时间'):main.innerText,controls:[...main.querySelectorAll('button,input,select,th')].map(element=>{const style=getComputedStyle(element);return{text:element.textContent,type:element.getAttribute('type'),fontSize:style.fontSize,padding:style.padding,color:style.color,background:style.backgroundColor};})}));}
try{
 const candidate=await login(origin),previous=await login(baseline);
 for(const path of ['/ui/pattern-room/orders','/ui/sourcing/pending','/ui/cutting',fixture.reviewUrl,...JSON.parse(process.env.V2_LEGACY_EXTRA_PATHS||'[]')]){
  for(const [page,url] of [[candidate,origin],[previous,baseline]]){
   await page.goto(url+path);await page.locator('.current-user').waitFor();await page.waitForLoadState('networkidle');
   await page.waitForFunction(()=>{const main=document.querySelector('.app-shell > main');return main&&!/正在加载|加载中|读取中|正在读取/.test(main.innerText);});
   if(path===fixture.reviewUrl)await page.getByText('全部可确认',{exact:true}).waitFor();
   if(path==='/ui/pattern-room/orders')await page.getByText('全部创建人',{exact:true}).waitFor({state:'attached'});
  }
  assert.deepEqual(await interior(candidate),await interior(previous),path);
  results.push({path,status:'PASS',textAndControlStylesEqual:true});
 }
 assert.deepEqual(errors,[]);
}finally{
 await writeFile(out+'/legacy-result.json',JSON.stringify({sha:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),dirty:Boolean(execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim()),results,errors},null,2));
 await browser.close();
}
console.log(JSON.stringify({passed:results.length}));
