import assert from 'node:assert/strict';
import {build} from 'vite';
import {mkdtemp,readFile,readdir,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer} from 'node:http';
const {chromium}=await import(process.env.PLAYWRIGHT_IMPORT||'playwright'),out=await mkdtemp(join(tmpdir(),'dx-qc-ui-')),evidence=process.env.QC_UI_EVIDENCE??'/workspace/dx-p06-browser',results=[],errors=[];
let server,browser,page;
try{
 await mkdir(evidence,{recursive:true});
 await build({configFile:false,esbuild:{jsx:'automatic'},define:{'import.meta.env.BASE_URL':'"/"','process.env.NODE_ENV':'"production"'},build:{outDir:out,lib:{entry:resolve('tests/fixtures/qc-production-progress-ui.tsx'),name:'QcUi',formats:['iife']}}});
 const files=await readdir(out),js=await readFile(join(out,files.find(n=>n.endsWith('.js'))),'utf8'),css=await readFile(join(out,files.find(n=>n.endsWith('.css'))),'utf8');
 const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script>${js.replace(/<\/script/gi,'<\\/script')}</script></html>`;
 server=createServer((_,res)=>{res.setHeader('content-type','text/html;charset=utf-8');res.end(html);});await new Promise(r=>server.listen(0,'127.0.0.1',r));browser=await chromium.launch({headless:true,executablePath:'/usr/bin/chromium',args:['--no-sandbox']});
 for(const width of [1280,1440])for(const mode of (process.env.QC_UI_MODES?.split(',')??['normal','unknown','held','readfail','drafts','readonly','dense','loadfail','reject','photos'])){
  page=await browser.newPage({viewport:{width,height:1000}});page.on('pageerror',e=>errors.push(`${width}/${mode}: ${e.message}`));
  await page.goto(`http://127.0.0.1:${server.address().port}/?factoryAction=productionProgress&mode=${mode}`);
  const panel=page.locator('.qc-production-progress'),editor=panel.locator('.qc-progress-editor'),top=page.locator('.factory-flow>.pattern-actions');
  if(mode==='loadfail'){await panel.getByRole('alert').waitFor();await panel.getByRole('button',{name:'重新读取',exact:true}).click();}
  await panel.getByRole('heading',{name:'生产进度与现场照片',exact:true}).waitFor();await editor.getByRole('group',{name:'本次生产进度与照片'}).waitFor();
  if(mode==='normal'){await panel.getByRole('button',{name:'指派／更换QC',exact:true}).click();assert.notEqual(await page.locator('#factory-tasks').getAttribute('open'),null);await page.locator('#factory-tasks>summary').click();}
  if(mode==='readonly')assert.equal(await editor.getByRole('button',{name:'保存本次进度与照片'}).isDisabled(),true);
  else if(mode==='dense'){assert.equal(await editor.locator('.qc-progress-lines>section').count(),12);}
  else{
   await editor.getByLabel('本次记录这项PO').first().check();await editor.getByLabel('本次说明',{exact:true}).fill('TEST草稿与原请求');
   if(mode==='drafts'){
    for(const name of ['返回','刷新']){await top.getByRole('button',{name,exact:true}).click();await page.getByRole('dialog').waitFor();await page.getByRole('button',{name:'取消',exact:true}).click();assert.equal(await editor.getByLabel('本次说明',{exact:true}).inputValue(),'TEST草稿与原请求');}
    const settings=panel.locator('details').filter({has:page.getByText('质检负责人接收设置',{exact:true})});await settings.locator(':scope>summary').click();await settings.getByRole('combobox').selectOption('');await settings.getByRole('button',{name:'保存负责人'}).click();await settings.getByRole('status').waitFor();assert.equal(await editor.getByLabel('本次说明',{exact:true}).inputValue(),'TEST草稿与原请求');
   }else{
    if(mode==='photos'){
     const sharp=(await import('sharp')).default,files=[];for(const background of ['red','blue'])files.push({name:'TEST-很长的现场首件照片文件名'.repeat(6)+background+'.png',mimeType:'image/png',buffer:await sharp({create:{width:2,height:2,channels:3,background}}).png().toBuffer()});
     await editor.getByLabel('本次现场照片',{exact:true}).setInputFiles(files);await editor.getByRole('button',{name:'重试未完成图片',exact:true}).waitFor();assert.equal(await editor.locator('.qc-progress-photos>figure').count(),1);assert.equal(await editor.getByRole('button',{name:'保存本次进度与照片'}).isDisabled(),true);
     await editor.getByRole('button',{name:'重试未完成图片',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.qc-progress-photos>figure').length===2);await editor.getByLabel('本次现场照片',{exact:true}).setInputFiles([files[0]]);await editor.getByText('已就绪2张，保存后才关联本次记录。',{exact:true}).waitFor();
     await editor.getByLabel('本次新增成品量（选填）',{exact:true}).fill('1');await editor.getByRole('checkbox',{name:'首件事件（须附照片）',exact:true}).check();
     await page.screenshot({path:join(evidence,`${width}-photos-ready.png`),fullPage:true});
    }
    await editor.getByRole('button',{name:'保存本次进度与照片'}).dblclick();
    if(mode==='held'){await page.waitForFunction(()=>typeof window.resolveQcWrite==='function');for(const name of ['返回','刷新'])await top.getByRole('button',{name,exact:true}).click();assert.equal(await page.getByRole('dialog').count(),0);assert.equal(await editor.getByLabel('本次说明',{exact:true}).inputValue(),'TEST草稿与原请求');await page.evaluate(()=>window.resolveQcWrite());}
    if(mode==='unknown'){
     await editor.getByRole('button',{name:'恢复原提交',exact:true}).waitFor();await top.getByRole('button',{name:'返回',exact:true}).click();await page.getByRole('dialog').waitFor();await page.getByRole('button',{name:'确认',exact:true}).click();await page.getByRole('button',{name:'重新进入原订单',exact:true}).click();await panel.locator('.qc-progress-editor').getByRole('button',{name:'恢复原提交',exact:true}).click();
    }
    if(mode==='reject'){await editor.getByRole('alert').filter({hasText:'TEST范围已变化'}).waitFor();assert.equal(await editor.getByLabel('本次说明',{exact:true}).inputValue(),'TEST草稿与原请求');}
    else if(mode==='readfail'){await editor.getByRole('status').filter({hasText:'刷新资料失败'}).waitFor();assert.equal(await editor.getByRole('button',{name:'保存本次进度与照片'}).isDisabled(),true);await panel.getByRole('button',{name:'重新读取生产记录',exact:true}).click();}
    else await editor.getByRole('status').filter({hasText:'本次记录已保存'}).waitFor();
    if(mode!=='reject')assert.equal(await page.evaluate(()=>window.qcWrites()),1);
    const requests=await page.evaluate(()=>window.qcRequests.filter(r=>r.url.endsWith('/qc-progress')));assert.equal(requests.length,mode==='unknown'?2:1);if(mode==='photos'){assert.equal(requests[0].body.attachmentIds.length,2);assert.equal(requests[0].body.observations[0].additionalFinishedQuantity,1);}if(mode==='unknown'){assert.equal(requests[0].key,requests[1].key);assert.deepEqual(requests[0].body,requests[1].body);}
   }
  }
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.screenshot({path:join(evidence,`${width}-${mode}.png`),fullPage:true});results.push({width,mode,passed:true});await page.close();page=null;
 }
 assert.deepEqual(errors,[]);await writeFile(join(evidence,'results.json'),JSON.stringify({cases:results.length,results,errors,scope:'actual factory parent and QC components with injected TEST HTTP, not live authenticated acceptance'},null,2));console.log(JSON.stringify({cases:results.length,errors}));
}catch(error){if(page){await page.screenshot({path:join(evidence,'failure.png'),fullPage:true});await writeFile(join(evidence,'failure.html'),await page.content());}console.error(JSON.stringify({errors}));throw error;}finally{await page?.close();await browser?.close();if(server)await new Promise(r=>server.close(r));await rm(out,{recursive:true,force:true});}
