// Isolated browser acceptance: real SourcingWorkspacePage, synthetic API/OSS only.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {build} from 'vite';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer} from 'node:http';

const {chromium}=await import(process.env.PLAYWRIGHT_IMPORT||'playwright');
await test('嘉顺专职文员在PC与移动端仅可下载合同、回签及补传；撤权后停止提交',async()=>{
  const output=await mkdtemp(join(tmpdir(),'dx-jiashun-clerk-'));
  let server,browser;
  try{
    await build({configFile:false,esbuild:{jsx:'automatic'},define:{'import.meta.env.BASE_URL':'"/"','process.env.NODE_ENV':'"production"'},
      build:{outDir:output,lib:{entry:resolve('tests/fixtures/contract-transfer-delivery.tsx'),name:'JiashunClerk',formats:['iife']}}});
    const files=await readdir(output);
    const js=await readFile(join(output,files.find(name=>name.endsWith('.js'))),'utf8');
    const css=await readFile(join(output,files.find(name=>name.endsWith('.css'))),'utf8');
    const html='<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>'+css+'</style><div id="root"></div><script>'+js.replace(/<\/script/gi,'<\\/script')+'</script></html>';
    server=createServer((_request,response)=>{response.setHeader('content-type','text/html;charset=utf-8');response.end(html);});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{}),args:['--no-sandbox']});
    const origin='http://127.0.0.1:'+server.address().port;
    for(const width of [390,1440])for(const scenario of ['success','role-revoked']){
      const page=await browser.newPage({viewport:{width,height:900}}),errors=[];
      page.on('pageerror',error=>errors.push(error.message));
      await page.goto(origin+'/?role=jiashun&uploadCase=1'+(scenario==='role-revoked'?'&uploadOutcome=role-revoked':''));
      try { await page.locator('.sourcing-contract-bar').waitFor({timeout:10000}); }
      catch (error) { console.log(JSON.stringify({width,scenario,errors})); throw error; }
      await page.getByRole('link',{name:'下载合同',exact:true}).waitFor();
      assert.equal(await page.getByRole('link',{name:'下载合同',exact:true}).count(),1);
      assert.equal(await page.getByRole('button',{name:'查看回签文件',exact:true}).count(),1);
      for(const name of ['提交转厂','提交调价与选厂','正式派单','修改款号','生成合同']){
        assert.equal(await page.getByRole('button',{name,exact:true}).count(),0,name+' should not be writable');
      }
      const file=page.locator('.sourcing-contract-return-actions input[type="file"]');
      await file.setInputFiles({name:'TEST-嘉顺回签.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-1.4\nTEST-only')});
      await page.waitForFunction(()=>window.contractTransferRequests.some(row=>row.method==='POST'&&row.path.endsWith('/contract-return')));
      const writes=await page.evaluate(()=>window.contractTransferRequests.filter(row=>row.method==='POST'));
      const intent=writes.find(row=>row.path.endsWith('/tools/attachments/upload-intents'));
      assert.equal(intent.body.sourcingCaseId,'00000000-0000-4000-8000-000000000100');
      assert.equal(intent.body.expectedContractDocumentId,'00000000-0000-4000-8000-000000000055');
      assert.equal(writes.filter(row=>row.path.endsWith('/contract-return')).length,1);
      if(scenario==='success'){
        await page.getByText(/TEST-嘉顺回签.pdf.*上传成功/).waitFor();
      }else{
        await page.getByRole('alert').filter({hasText:'权限或订单工厂已变化'}).waitFor();
        assert.equal(await page.getByRole('button',{name:'补传回签合同',exact:true}).count(),0);
        assert.equal(await page.getByRole('button',{name:'重试保存',exact:true}).count(),0);
      }
      assert.equal(await page.evaluate(()=>document.body.scrollWidth>innerWidth),false);
      assert.deepEqual(errors,[]);
      console.log(JSON.stringify({width,scenario,passed:true}));
      await page.close();
    }
  }finally{
    await browser?.close();
    if(server)await new Promise(resolve=>server.close(resolve));
    await rm(output,{recursive:true,force:true});
  }
});
