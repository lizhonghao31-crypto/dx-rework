// Targeted UI adapter regression: synthetic sourcing task, real local TEST order/budget.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {mintAcceptanceLoginCode} from '../../apps/api/src/auth/acceptance-provider.ts';
import {journeyReturnUrl} from '../../packages/contracts/src/digital-production-journey.ts';
const {chromium}=await import(process.env.PLAYWRIGHT_IMPORT||'playwright');
const env=JSON.parse(await readFile(process.env.V2_LOCAL_ENV_FILE,'utf8'));
const fixture=JSON.parse(await readFile(process.env.V2_LOCAL_FIXTURE_FILE,'utf8'));
assert.equal(fixture.runId,'TEST-V2-STAGE01-FIX');
const origin=process.env.V2_CANDIDATE_URL||'http://127.0.0.1:3217';assert(['localhost','127.0.0.1'].includes(new URL(origin).hostname));
const out=process.env.V2_REAL_EVIDENCE_DIR;assert(out);await mkdir(out,{recursive:true});
const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true});
try{
 const context=await browser.newContext({viewport:{width:1672,height:941}});
 assert.equal((await context.request.post(origin+'/api/auth/mobile',{data:{code:mintAcceptanceLoginCode('root',env.ACCEPTANCE_LAB_SECRET)}})).status(),200);
 const order=await (await context.request.get(origin+'/api/digital-production/journeys/'+fixture.sourceId)).json();assert.equal(order.designStyleNo,'TEST-V2-PLAN');
 const taskRecord=order.stages.flatMap(stage=>stage.nodes).flatMap(node=>node.records).find(record=>record.domain==='task');assert(taskRecord);
 const real=await (await context.request.get(origin+'/api/digital-production/tasks/'+taskRecord.id)).json();
 const id='10000000-0000-4000-8000-000000000650';
 const page=await context.newPage();
 await page.route('**/api/digital-production/tasks/'+id,route=>{assert.equal(route.request().method(),'GET');return route.fulfill({json:{...real,taskId:id,taskKind:'sourcing_preparation',orderId:order.orderId,sourceId:null}});});
 await page.route('**/api/digital-production/tasks/'+id+'/history',route=>{assert.equal(route.request().method(),'GET');return route.fulfill({json:{events:[],revisions:[]}});});
 const back=journeyReturnUrl({search:'TEST-PR03-PAGE',page:2,kpi:'all',selected:fixture.sourceId,expanded:'preparation',focus:id,row:'',flow:'collapsed'});
 await page.goto(origin+'/ui/digital-production?task='+id+'&returnTo='+encodeURIComponent(back));
 const link=page.getByRole('link',{name:'打开预算与外发办理',exact:true});await link.waitFor();
 assert.equal(new URL(await link.getAttribute('href'),origin).searchParams.get('returnTo'),back);
 await link.click();await page.getByRole('heading',{name:'成本预算表',exact:true}).waitFor();
 assert.equal(new URL(page.url()).searchParams.get('budget'),order.orderId);
 await page.getByRole('button',{name:'返回',exact:true}).click();await page.locator('.journey-three-columns').waitFor();
 assert.equal(new URL(page.url()).search,back.slice(back.indexOf('?')));
 await writeFile(out+'/sourcing-task-return.json',JSON.stringify({sha:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),dirty:Boolean(execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim()),status:'PASS',case:'sourcing task -> original budget -> original close restores all cockpit context',fixture:'Synthetic GET task/history only; actual local TEST order, budget, authentication and return UI; no business commands'},null,2));
 console.log('PASS synthetic sourcing-task adapter / real original budget close / exact return context');
}finally{await browser.close();}
