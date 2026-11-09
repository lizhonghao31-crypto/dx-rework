import assert from 'node:assert/strict';
import {test} from 'node:test';
import {build} from 'vite';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer} from 'node:http';
const {chromium}=await import(process.env.PLAYWRIGHT_IMPORT || 'playwright');
await test('one return-file entry supports desktop and mobile preview, version history and keyboard close',async()=>{
  const output=await mkdtemp(join(tmpdir(),'dx-return-files-'));let browser,server;
  try{
    await build({configFile:false,esbuild:{jsx:'automatic'},define:{'process.env.NODE_ENV':'"production"'},build:{outDir:output,lib:{entry:resolve('tests/fixtures/contract-return-files.tsx'),name:'ReturnFiles',formats:['iife']}}});
    const names=await readdir(output),js=await readFile(join(output,names.find(n=>n.endsWith('.js'))),'utf8'),css=await readFile(join(output,names.find(n=>n.endsWith('.css'))),'utf8');
    const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script>${js.replace(/<\/script/gi,'<\\/script')}</script></html>`;
    server=createServer((request,response)=>{if(request.url.startsWith('/files/')){response.writeHead(200,{'content-type':'text/plain'});response.end('TEST preview');return;}response.setHeader('content-type','text/html;charset=utf-8');response.end(html);});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{}),args:['--no-sandbox']});
    for(const width of [390,1440]){
      const page=await browser.newPage({viewport:{width,height:900}}),origin=`http://127.0.0.1:${server.address().port}`,errors=[];
      page.on('pageerror',error=>errors.push(error.message));
      await page.goto(origin);
      const entry=page.getByRole('button',{name:'查看回签文件',exact:true});
      await entry.waitFor();assert.equal(await entry.count(),1);await entry.click();
      const dialog=page.getByRole('dialog');await dialog.waitFor();
      assert.equal(await dialog.locator('nav button').count(),5);
      assert.equal(await dialog.locator('iframe').count(),1);
      assert.equal(await dialog.getByRole('button',{name:'上一份',exact:true}).isDisabled(),true);
      await dialog.getByRole('button',{name:'下一份',exact:true}).click();
      await dialog.getByRole('alert').waitFor(); // Invalid synthetic image exercises failure and recovery controls.
      await dialog.getByRole('button',{name:'下一份',exact:true}).click();
      await dialog.locator('iframe[title="TEST-3.pdf"]').waitFor();
      assert.equal(await dialog.getByRole('link',{name:'下载',exact:true}).getAttribute('href'),'/files/00000000-0000-4000-8000-000000000003?mode=download');
      await dialog.getByRole('button',{name:'TEST-4.pdf',exact:true}).click();
      await dialog.locator('iframe[title="TEST-4.pdf"]').waitFor();
      assert.equal(await page.evaluate(()=>document.body.scrollWidth>innerWidth),false);
      assert.equal(await dialog.evaluate(el=>el.scrollWidth>el.clientWidth+1),false);
      await page.keyboard.press('Escape');assert.equal(await dialog.count(),0);assert.equal(await entry.evaluate(el=>el===document.activeElement),true);
      await page.goto(origin+'/?scenario=new-version');await entry.click();await page.getByText('本版本无回签记录，以下为历史回签文件。',{exact:true}).waitFor();await page.getByRole('button',{name:'关闭',exact:true}).click();
      await page.goto(origin+'/?scenario=empty');assert.equal(await entry.count(),0);assert.deepEqual(errors,[]);await page.close();
    }
  }finally{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));await rm(output,{recursive:true,force:true});}
});
