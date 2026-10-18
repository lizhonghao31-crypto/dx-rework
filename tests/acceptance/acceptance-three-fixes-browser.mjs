// Actual designer workspace and Shell with intercepted synthetic GETs only.
import assert from 'node:assert/strict';
import {build} from 'vite';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,readdir,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer} from 'node:http';
const baseline=process.argv.includes('--baseline');
assert.ok(process.argv.slice(2).every(value=>value==='--baseline'));
const directory=process.env.THREE_FIXES_EVIDENCE;
const git=(...args)=>execFileSync('git',args,{encoding:'utf8'}).trim();
const provenance={startedAtUtc:new Date().toISOString(),head:git('rev-parse','HEAD'),tree:git('rev-parse','HEAD^{tree}'),dirtyPaths:git('status','--porcelain').split('\n').filter(Boolean),productDiffSha256:createHash('sha256').update(git('diff','HEAD','--','apps','packages')).digest('hex')};
if(process.env.EXPECTED_HEAD_SHA){assert.equal(provenance.head,process.env.EXPECTED_HEAD_SHA);assert.deepEqual(provenance.dirtyPaths,[],'frozen evidence requires a clean checkout');}
const {chromium}=await import(process.env.PLAYWRIGHT_IMPORT||'playwright');
const output=await mkdtemp(join(tmpdir(),'dx-acceptance-three-')),results=[],failures=[],errors=[],external=[];
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const long='TEST-仅验收附件长文件名可读性-20261017-中文与English混合-ABCDEFGHIJKLMNOPQRSTUVWXYZ-0123456789-不得用于真实生产.png';
let browser,server;
try{
 if(directory)await mkdir(directory,{recursive:true});
 browser=await chromium.launch({headless:true,executablePath:'/usr/bin/chromium',args:['--no-sandbox']});
 for(const base of ['/','/acceptance/']){
  const dist=join(output,base==='/'?'root':'acceptance');
  await build({configFile:false,esbuild:{jsx:'automatic'},define:{'import.meta.env.BASE_URL':JSON.stringify(base),'process.env.NODE_ENV':'"production"'},build:{outDir:dist,lib:{entry:resolve('tests/fixtures/digital-source-context.tsx'),name:'ActualDesignerFixture',formats:['iife']}}});
  const names=await readdir(dist),js=await readFile(join(dist,names.find(n=>n.endsWith('.js'))),'utf8'),css=await readFile(join(dist,names.find(n=>n.endsWith('.css'))),'utf8');
  const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script>${js.replace(/<\/script/gi,'<\\/script')}</script></html>`;
  server=createServer((req,res)=>{if(req.url.includes('/attachments/')){res.setHeader('content-type','image/svg+xml');res.end('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="650"><rect width="800" height="650" fill="#d5e4f0"/><text x="20" y="40">TEST synthetic original 800 x 650</text></svg>');return;}res.setHeader('content-type','text/html;charset=utf-8');res.end(html);});
  await new Promise(done=>server.listen(0,'127.0.0.1',done));
  const cases=[...([1180,390].map(width=>({kind:'context',width,editable:false,failure:false}))),...(base==='/acceptance/'?[{kind:'layout',width:1180,editable:true,failure:false},{kind:'layout',width:1180,editable:false,failure:false},{kind:'layout',width:1180,editable:true,failure:true},{kind:'layout',width:390,editable:true,failure:false},{kind:'layout',width:390,editable:false,failure:false},{kind:'layout',width:360,editable:true,failure:true}]:[])];
  for(const scenario of cases){
   const label=[base==='/'?'root':'acceptance',scenario.kind,scenario.width,scenario.editable?'edit':'read',scenario.failure?'failure':'success'].join('-');
   const page=await browser.newPage({viewport:{width:scenario.width,height:900},hasTouch:scenario.width<500});page.setDefaultTimeout(7000);page.on('pageerror',e=>errors.push({label,message:e.message}));
   await page.route('**/*',route=>{const url=new URL(route.request().url());if(url.hostname==='127.0.0.1')return route.continue();external.push({label,url:url.href});return route.abort();});
   const record={label,scenario,base,startedAtUtc:new Date().toISOString(),checks:[]};
   try{
    const search=scenario.kind==='context'?'TEST-DESIGNER-CONTEXT':'TEST-ATTACHMENT-LAYOUT';
    const query=new URLSearchParams({workspace:'designer',page:'1',search,view:scenario.editable?'draft':'all',selected:id(2),...(scenario.kind==='layout'?{development:id(2),round:'3'}:{}),...(scenario.failure?{customer:'FAIL-FIRST'}:{})});
    await page.goto(`http://127.0.0.1:${server.address().port}${base}ui/digital-production?${query}`);
    await page.locator('.desktop-navigation').waitFor({state:'attached'});
    if(scenario.kind==='context'){
     await page.getByRole('link',{name:'本单资料 · 开发单 / 附件',exact:true}).click();
     await page.getByRole('button',{name:'轮次与记录',exact:true}).click();
     const current=new URL(page.url()),link=page.getByRole('link',{name:'车板 · 第2轮原记录',exact:true});await link.waitFor();
     record.inheritedHref=await link.getAttribute('href');
     await link.click();await page.locator('.task-workbench-sample').waitFor();
     assert.equal(new URL(page.url()).searchParams.get('taskView'),'read');
     assert.equal(await page.getByRole('button',{name:'车板完成，交给下一位',exact:true}).count(),0,'inherited record remains read-only');
     await page.getByRole('button',{name:'返回来源',exact:true}).click();
     const returned=new URL(page.url());
     for(const key of ['workspace','page','search','view','selected','development','round','documentChapter'])assert.equal(returned.searchParams.get(key),current.searchParams.get(key),'restored '+key);
     await page.getByRole('button',{name:'轮次与记录',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'轮次与记录',exact:true}).getAttribute('aria-pressed'),'true');
     assert.equal(await page.getByRole('combobox',{name:'查看轮次',exact:true}).inputValue(),'3');
     await page.reload();await page.getByRole('button',{name:'轮次与记录',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'轮次与记录',exact:true}).getAttribute('aria-pressed'),'true');
     record.checks.push('actual designer archive to round 3, inherited round 2 read-only task and back restores all eight context fields','restored chapter and round survive reload');
    }else{
     const row=page.locator('.development-file-list > div').first(),link=row.getByRole('link',{name:'查看原附件',exact:true});await link.waitFor();await row.scrollIntoViewIfNeeded();
     const actions=async()=>row.locator('a,button').evaluateAll(nodes=>nodes.map(e=>{const r=e.getBoundingClientRect(),walker=document.createTreeWalker(e,NodeFilter.SHOW_TEXT);const tops=[];let text;while((text=walker.nextNode())){if(!text.textContent.trim())continue;const range=document.createRange();range.selectNodeContents(text);for(const box of range.getClientRects())tops.push(Math.round(box.top));}return {text:e.textContent,width:r.width,height:r.height,lines:new Set(tops).size,whiteSpace:getComputedStyle(e).whiteSpace};}));
     record.actions=await actions();assert.ok(record.actions.every(a=>a.lines===1),'each action stays on one text line: '+JSON.stringify(record.actions));
     assert.equal(await row.getByRole('button',{name:'移除',exact:true}).count(),scenario.editable?1:0,'original edit/read permission branch');
     if(scenario.failure){await row.getByText('未能读取附件名称，请重试或核对当前查看权限。',{exact:true}).waitFor();await row.getByRole('button',{name:'重试读取附件名称',exact:true}).click();}
     const summary=row.locator('.attachment-name summary');await summary.waitFor();assert.equal(await summary.innerText(),long);assert.equal(await summary.getAttribute('title'),long);
     assert.ok(await summary.locator('span').evaluate(e=>e.scrollWidth>e.clientWidth),'long name is ellipsized');
     await summary.focus();await summary.press('Enter');assert.equal(await row.locator('.attachment-name__full').innerText(),long);assert.ok(await row.locator('.attachment-name__full').isVisible());await summary.press('Space');assert.equal(await row.locator('details').evaluate(e=>e.open),false);
     const image=page.locator('.development-main-picture img').first();await image.waitFor();await page.waitForFunction(()=>document.querySelector('.development-main-picture img')?.naturalWidth===800);assert.deepEqual(await image.evaluate(e=>({width:e.naturalWidth,height:e.naturalHeight})),{width:800,height:650});
     const popupPromise=page.waitForEvent('popup');await link.click();const popup=await popupPromise;await popup.waitForLoadState();assert.ok(popup.url().includes('/attachments/'));await popup.close();
     await row.scrollIntoViewIfNeeded();record.actionsAfter=await actions();assert.ok(record.actionsAfter.every(a=>a.lines===1));
     record.geometry=await row.evaluate(e=>{const r=e.getBoundingClientRect(),name=e.querySelector('.attachment-identity').getBoundingClientRect();return {row:{left:r.left,right:r.right,width:r.width},name:{left:name.left,right:name.right,width:name.width},viewport:innerWidth};});
     assert.ok(record.geometry.row.right<=scenario.width+1&&record.geometry.row.left>=-1);assert.ok(record.geometry.name.right<=record.geometry.row.right+1);
     record.checks.push('actual designer Shell internal attachment row keeps original link/removal actions on one text line','editable/readonly branch unchanged','ellipsis and keyboard full-name disclosure retained','original preview opens the same file and intrinsic dimensions remain 800x650',scenario.failure?'metadata failure and actual retry preserve action space':'loaded metadata preserves action space');
     if(directory)await page.screenshot({path:join(directory,label+'.png'),fullPage:false});
     if(scenario.editable){await row.getByRole('button',{name:'移除',exact:true}).click();assert.equal(await page.locator('.development-file-list > div').count(),0);record.checks.push('removal changes local draft only');}
    }
    assert.deepEqual(await page.evaluate(()=>window.sourceContextFixture.unexpected),[]);
    assert.deepEqual(await page.evaluate(()=>window.sourceContextFixture.requests.filter(r=>r.method!=='GET')),[]);
    record.pass=true;
   }catch(error){record.pass=false;record.failure=String(error);failures.push({label,message:String(error)});if(directory)await page.screenshot({path:join(directory,label+'-failure.png'),fullPage:false}).catch(()=>{});}
   record.finishedAtUtc=new Date().toISOString();results.push(record);await page.close();console.log(label+': '+(record.pass?'PASS':'FAIL'));
  }
  await new Promise(done=>server.close(done));server=null;
 }
 assert.deepEqual(errors,[]);assert.deepEqual(external,[]);if(failures.length)process.exitCode=1;
}finally{
 if(directory)await writeFile(join(directory,'result.json'),JSON.stringify({mode:baseline?'baseline':'candidate',provenance:{...provenance,finishedAtUtc:new Date().toISOString()},results,failures,errors,external,limits:['Actual designer workspace, original router and Shell; all reads/files are intercepted synthetic fixtures, not live Acceptance.','Touch is browser emulation. No deployed business API/database calls or writes.']},null,2));
 await browser?.close();if(server)await new Promise(done=>server.close(done));await rm(output,{recursive:true,force:true});
}
console.log(JSON.stringify({records:results.length,passed:results.filter(r=>r.pass).length,failures,errors,external}));
