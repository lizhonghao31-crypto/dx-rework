import assert from 'node:assert/strict';
import { build } from 'vite';
import { mkdtemp,readFile,readdir,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { createServer } from 'node:http';
const {chromium}=await import(process.env.PLAYWRIGHT_IMPORT || 'playwright');
const output=await mkdtemp(join(tmpdir(),'pmc-readonly-ui-'));let browser,server;const results=[];
try{
 await build({configFile:false,esbuild:{jsx:'automatic'},define:{'import.meta.env.BASE_URL':'"/"','process.env.NODE_ENV':'"production"'},build:{outDir:output,lib:{entry:resolve('tests/fixtures/warehouse-supervisor.tsx'),name:'PmcReader',formats:['iife']}}});
 const files=await readdir(output),js=await readFile(join(output,files.find(f=>f.endsWith('.js'))),'utf8'),css=await readFile(join(output,files.find(f=>f.endsWith('.css'))),'utf8');
 const html='<html lang="zh-CN"><meta name="viewport" content="width=device-width,initial-scale=1"><style>'+css+'</style><div id="root"></div><script>'+js.replace(/<\/script/gi,'<\\/script')+'</script></html>';
 server=createServer((_req,res)=>{res.setHeader('content-type','text/html;charset=utf-8');res.end(html);});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});
 const origin='http://127.0.0.1:'+server.address().port;
 for(const width of [390,1440]) for(const role of ['pmc','pm']){
  const page=await browser.newPage({viewport:{width,height:960}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(origin+'/ui/suppliers/requests?role='+role);await page.getByText('TEST供应商申请',{exact:true}).waitFor();
  const readLink=page.getByRole('link',{name:role==='pmc'?'查看':'审批',exact:true});await readLink.click();await page.getByRole('heading',{name:'TEST供应商申请',exact:true}).waitFor();
  await page.getByText('123456789',{exact:true}).waitFor();await page.getByText('001234567890',{exact:true}).waitFor();
  assert.equal(await page.locator('form.supplier-approval-actions').count(),role==='pmc'?0:1);
  assert.equal(await page.locator('input[type=file]').count(),0);
  assert.equal((await page.evaluate(()=>window.warehouseTestRequests.filter(r=>r.method!=='GET'))).length,0);assert.deepEqual(errors,[]);
  results.push({role,width,listAndDetail:true,sensitiveFields:true,readOnly:role==='pmc',passed:true});await page.close();
 }
 console.log(JSON.stringify({localOnly:true,synthetic:true,results},null,2));
}finally{await browser?.close();if(server)await new Promise(r=>server.close(r));await rm(output,{recursive:true,force:true});}
