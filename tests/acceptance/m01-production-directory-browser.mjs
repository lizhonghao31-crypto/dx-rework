import assert from 'node:assert/strict';
import {build} from 'vite';
import {mkdtemp,readFile,readdir,rm,mkdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:http';
const {chromium}=await import(process.env.PLAYWRIGHT_IMPORT||'playwright');
const out=await mkdtemp(join(tmpdir(),'dx-p03-directory-')),evidence=process.env.P03_DIRECTORY_EVIDENCE;
assert.ok(evidence,'Explicit private evidence directory required');const results=[],errors=[];let browser,server,page;
try{
 await mkdir(evidence,{recursive:true});await build({configFile:false,logLevel:'error',esbuild:{jsx:'automatic',jsxDev:false},define:{'import.meta.env.BASE_URL':'"/"','process.env.NODE_ENV':'"production"'},build:{outDir:out,lib:{entry:resolve('tests/fixtures/m01-production-directory.tsx'),name:'P03DirectoryFixture',formats:['iife']}}});
 const files=await readdir(out),js=await readFile(join(out,files.find(f=>f.endsWith('.js'))),'utf8'),css=(await Promise.all(files.filter(f=>f.endsWith('.css')).map(f=>readFile(join(out,f),'utf8')))).join('\n');
 server=createServer((_req,res)=>{res.writeHead(200,{'content-type':'text/html;charset=utf-8'});res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script>${js.replace(/<\/script/gi,'<\\/script')}</script></html>`);});await new Promise(done=>server.listen(0,'127.0.0.1',done));
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});const origin=`http://127.0.0.1:${server.address().port}`;
 const openAll=async()=>{await page.getByRole('button',{name:'查看全部',exact:true}).click();await page.getByRole('dialog',{name:'全部相关单据'}).waitFor();await page.waitForFunction(()=>[...document.querySelectorAll('.cockpit-documents-dialog .cockpit-document-category')].every(e=>['ready','error'].includes(e.dataset.readState)));};
 const category=key=>page.locator(`.cockpit-document-category:has(> summary[data-document-focus="${key}"])`);
 const ensureOpen=async category=>{if(!await category.evaluate(e=>e.open))await category.locator(':scope > summary').click();};
 for(const width of [1440,390])for(const mode of ['coexist','current','qc']){
  page=await browser.newPage({viewport:{width,height:1000}});page.setDefaultTimeout(12000);page.on('pageerror',e=>errors.push(e.message));await page.goto(`${origin}?case=${mode}${mode==='qc'?'&view=qc':''}`);
  if(mode==='qc'){
   await page.getByText('已退出的工厂记录',{exact:true}).click();await page.getByText('TEST旧厂 · 零报量',{exact:true}).waitFor();await page.getByText('未记录QC现场进度或照片；不因此要求旧厂补报或补收货。',{exact:true}).waitFor();assert.match(await page.locator('body').innerText(),/当前份额0件/);assert.equal(await page.getByRole('button',{name:'保存本次进度',exact:true}).count(),0);
  }else{
   await page.waitForFunction(()=>document.querySelector('.cockpit-document-priority-row[data-category="technical"]')?.dataset.readState==='ready');await openAll();
   const instruction=category('instruction');await ensureOpen(instruction);await instruction.getByText('生产当前采用 · 大货制单第 6 版',{exact:true}).waitFor();await instruction.getByText('尚未生效 · 大货制单草稿第 7 版',{exact:true}).waitFor();
   const technical=category('technical');await ensureOpen(technical);await technical.getByText(`已发布制单第 6 版的采用资料 · 开发第 ${mode==='coexist'?1:2} 轮`,{exact:true}).click();const artifact=technical.getByText(/制单第 6 版采用 · 本轮引用 ·/);await artifact.waitFor();assert.match(await artifact.innerText(),/第 1 轮技术成果 v1/);await artifact.click();await technical.getByRole('link',{name:'PLT纸样原件 1',exact:true}).waitFor();assert.match(await technical.getByRole('link',{name:'PLT纸样原件 1',exact:true}).getAttribute('href'),/000000000030/);
   await technical.getByText('本版制单发布时间',{exact:true}).waitFor();await technical.getByText('原成果发布时间',{exact:true}).waitFor();if(mode==='current')await technical.getByText('本轮沿用时间',{exact:true}).waitFor();
   const development=category('development');await ensureOpen(development);await development.getByText('第 2 轮 · 单据 v5 · 已发布',{exact:true}).waitFor();await development.getByText('尚未生效 · 开发复版草稿第 3 版',{exact:true}).waitFor();
   const qc=category('qc_progress');await ensureOpen(qc);await qc.getByText('TEST旧厂 · 零报量 · 已退出的工厂记录',{exact:true}).waitFor();
   await page.screenshot({path:join(evidence,`${width}-${mode}.png`),fullPage:true});
   await page.getByRole('button',{name:'关闭全部相关单据',exact:true}).click();await page.evaluate(()=>{window.p03Fixture.revoked=true;});await openAll();const restricted=category('technical');await ensureOpen(restricted);await restricted.getByText('本单制单可读；当前身份无权读取其原开发技术资料，请由原有权岗位核对。',{exact:true}).waitFor();assert.equal(await page.getByRole('link',{name:'PLT纸样原件 1',exact:true}).count(),0);const stillReadable=category('instruction');await ensureOpen(stillReadable);await stillReadable.getByText('生产当前采用 · 大货制单第 6 版',{exact:true}).waitFor();
  }
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);const state=await page.evaluate(()=>window.p03Fixture);assert.ok(state.requests.every(r=>r.method==='GET'));assert.ok(state.peak<=3);results.push({width,mode,requests:state.requests.length,peak:state.peak,checks:mode==='qc'?['original QC history panel','zero record retired scope','no retired write entry']:['published vs draft','exact frozen artifact','separate original/inheritance/publication times','zero-record history','same-actor source revocation on reopen','independent instruction access']});if(mode==='qc')await page.screenshot({path:join(evidence,`${width}-${mode}.png`),fullPage:true});await page.close();page=null;
 }
 assert.deepEqual(errors,[]);
}catch(error){if(page&&!page.isClosed()){await page.screenshot({path:join(evidence,'failure.png'),fullPage:true});await writeFile(join(evidence,'failure.txt'),await page.locator('body').innerText());}throw error;}
finally{await writeFile(join(evidence,'results.json'),JSON.stringify({results,errors,limits:['Original directory/QC components with synthetic TEST HTTP and fixture identities; other unprovided categories return explicit404. No live order/role acceptance, file-byte download, shell redesign or deployment claimed. Native byte downloads tested separately on isolated PostgreSQL/private storage.']},null,2));await browser?.close();if(server)await new Promise(done=>server.close(done));await rm(out,{recursive:true,force:true});}
console.log(JSON.stringify({passed:results.length,errors}));
