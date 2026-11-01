import assert from 'node:assert/strict';
import {build} from 'vite';
import {mkdtemp,readFile,readdir,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer} from 'node:http';
const {chromium}=await import(process.env.PLAYWRIGHT_IMPORT||'playwright');
const output=await mkdtemp(join(tmpdir(),'dx-creation-options-')),evidence=process.env.CREATION_OPTIONS_EVIDENCE;
const results=[],errors=[];let server,browser;
try{
  await build({configFile:false,esbuild:{jsx:'automatic'},define:{'import.meta.env.BASE_URL':'"/"','process.env.NODE_ENV':'"production"'},build:{outDir:output,lib:{entry:resolve('tests/fixtures/development-create-options.tsx'),name:'CreationOptions',formats:['iife']}}});
  const names=await readdir(output),js=await readFile(join(output,names.find(name=>name.endsWith('.js'))),'utf8'),css=await readFile(join(output,names.find(name=>name.endsWith('.css'))),'utf8');
  const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script>${js.replace(/<\/script/gi,'<\\/script')}</script></html>`;
  const testPicture=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAWgAAAG4CAIAAADnueqtAAANCElEQVR4nO3dXYjld33H8d+sW4tIoiaGNF1rqiarq4naxNBCqumND4kXWliNCApqKkpzIVUaK6E3rqWWCKJb2oJWXBufyE2wVQRLK95UVFARfEJU0KIgKjabhdVIL45MxnPm6TPn4f97eL2uDsuZme/5///znt9v/jM7W+cvXCwAiWNTDwC0RziAmHAAMeEAYsIBxIQDiAkHEBMOICYcQEw4gJhwADHhAGLCAcSEA4gJBxATDiAmHEBMOICYcAAx4QBiwgHEhAOICQcQEw4gJhxATDiAmHAAMeEAYsIBxIQDiAkHEBMOICYcQEw4gJhwADHhAGLCAcSEA4gJBxATDiAmHEBMOICYcAAx4QBiwgHEhAOICQcQEw4gJhxATDiAmHAAMeEAYsIBxIQDiB2fegCW9eq3vHPqEY7i3D13TT0CR7d1/sLFqWfgKBrtxSIFaZFwtKebZOwkH20Rjmbs2ov7zt69+UlW5fSdZxb/UUGaIBy122t90XQydto1H0VB6iYc9epvibE/C5CGCEd1RuvFIgWpn3DUovstScoWpmbCMT1LjP1ZgFRIOCajFykFqYdwbJotyZJsYWogHJtjibFaFiATEo6104t1U5DNE4512diWZPvTpokYrW9aW5hN8tuxq2eJMYntIzxXkNnpkI/VEo6V0YtK7FqQ7bOjICvhP/JZjcVq3Hf2btWY1q6noMvfLd48K44V2HktikVtFhcgr37LO607luSbo8varsaEyWjl+6M1zLk9g3Ysw1ZlKTVUg8j2mbJnWYZwHJ1qNEo7liccR1RnNfb6WYYaVDWbdixJOJZSSTUqGeOQKpm2kjEaJRxH4ctUT5zNIxCOWJ2blL1+brISNdxPWWTDcmTCkamzGnNqa0dt8+ykHUcjHIHKq1HnVDvVOaF2HIFwHFbl1ZipcMNS5yZljnakhONQmqjGnBraUcMMh6QdEeE4WFvV2DnktJ+3Oz96W4dOOw4kHAdoqxozNbSjuWrMaMchCcd+WqzGzLTtaLQaM9pxGMKxp3arMTNVO5quxox2HMiv1e+u9Wpsm0vGWl/OJj/WBvgF/H1Yceyim2qUhZewvqVHZ9Uo1h37suLYxexC6eDS32l9n9j9JWOn2auz6JgjHPN6Wm7M2XW5ceSXudr3Vi0bll0Jx2/puBrb9tmtHPiql3nbdmnHIuF42AjV2LbCb3YMdbi0Y0Y4fmOoaux05IIMe6C0owjHzLDVmHNgRByf2QPtEA7VIKAdM6P/HIdqEPHDHTNDh0M1OALtKCOHQzU4Mu0YNByqwZIGb8eI4VANVmLkdgwXDtVghYZtx3DhmFENVmXMa2mscIz2ZYFNGurqGigcNimsyYAbllHCoRqs1WjtGCIcqsEGDNWO/sOhGmzMOO3oPByqwYYN0o6ew6EaTGKEdnQbDtVgQt23o89wqAaT67sdHYZDNahEx+3oLRyqQVV6bUdX4VANKtRlO7oKx4xqUJv+rsl+wtFTzulVN1dpJ+GwSaFynW1YegiHatCEntrRfDhUg4Z00462w6EaNKePdjQcDtWgUR20o9VwqAZNa70dTYZDNehA0+1oLxyqQTfabUdj4VANOtNoO1oKh2rQpRbb0Uw4VIOONdeOZsIxoxr0qq1ru41wtJJhWF4TV3sD4bBJYRANbVhqD4dqMJRW2lF1OFSDATXRjnrDoRoMq/52VBoO1WBwlbej0nCcu+eu2YPTd56ZdhKYxPaVv/25UJVKw1G0g4FVXo1ScziKdjCk+qtRKg9H0Q4G00Q1Sv3hKNrBMFqpRmkiHEU7GEBD1SithKNoB11rqxqloXAU7aBTzVWjtBWOoh10p8VqlObCUbSDjjRajdJiOIp20IV2q1EaDUfRDhrXdDVKu+EoHbWj9fk3r/Uj1no1StPhKF20o93Jp9XuceugGqWUrfMXLk49w7La/R38xau/uZewSR0crj6qUVpfccw0uu5oa9o6tXUMu6lG6SMcpbV2nL7zzM45O7iMNmznEZs7mNXqqRqlm3CUdtoxl4w+LqPNmzt0rZz0bk53P+EoLbTDQmO1mmhHf9UonYWj1N0O1ViHytvRZTVKf+EotbZDNdan2nb0Wo3SZThKfe1QjXWrsB0dV6P0Go5STTvcQNmYqm619F2N0nE4SgXtcANlwyq51dJ9NUrf4SiTtsNCYyrTtmOEapTuw1EmaodqTGuqdgxSjTJCOMrG26EaNdh8O8apRhkkHGWD7VCNemyyHUNVo4wTjrL+driBUqHN3GoZrRplqHCUdbbDDZRqrftWy4DVKKOFo6ynHRYa9VtTO8asRhkwHGXV7VCNVqy8HcNWo4wZjrK6dqhGW1bYjpGrUYYNR1lFO1SjRStpx+DVKCOHoyzRDjdQmrbkrRbVKIOHoxypHW6gdODIt1pUY2b0cJSwHRYaPUnboRrbhKOUQ7dDNfpz+Haoxk7C8RsHtkM1enWYdqjGHOF42D7tUI2+7d8O1VgkHL9lsR1uoAxir1stqrGr41MPUJ1z99w1+5uSc195XDfdm53i7b8o6gvGPqw4drF4lbhuxuHsH4Zw7G7nteK6GY2zfyDh2NPsinHdjMnZ359w7Md1MzJnfx/CAcSEA4gJBxATDiAmHEBMOICYcAAx4QBiwgHEhAOICQcQEw4gJhxATDiAmHAAMeEAYsIBxIQDiAkHEBMOICYcQEw4gJhwADHhAGLCAcSEA4gJBxATDiAmHEBMOICYcAAx4QBiwgHEhAOICQcQEw4gJhxATDiAmHAAMeEAYsIBxIQDiAkHEBMOICYcQEw4gJhwADHhAGLCAcSEA4gJBxATDiAmHEBMOICYcAAx4QBiwgHEhAOICQcQEw4gJhxATDiAmHAAMeEAYsIBxIQDiAkHEBMOICYcQEw4gJhwADHhAGLCAcSEA4gJBxATDiAmHEBMOICYcAAx4QBiwgHEhAOICQcQEw4gJhxATDiAmHAAMeEAYsIBxIQDiAkHEBMOICYcQEw4gJhwADHhAGLCAcSEA4gJBxATDiAmHEBMOICYcAAx4QBiwgHEhAOICQcQEw4gJhxATDiAmHAAMeEAYsIBxIQDiAkHEBMOICYcQEw4gJhwADHhAGLCAcSEA4gJBxATDiAmHEBMOICYcAAx4QBiwgHEhAOICQcQEw4gJhxATDiAmHAAMeEAYsIBxIQDiAkHEBMOICYcQEw4gJhwADHhAGLCAcSEA4gJBxATDiAmHEBMOICYcAAx4QBiwgHEts5fuDj1DJQvfv37U4/QkuecunrqEUZnxQHEjk89AKWU8p73f3T24L6zd087Sc1O33lm9uDcPXdNOwlWHEBMOICYcAAx4QBiwgHEhAOICQcQEw4gJhxATDiAmHAAMeEAYsIBxIQDiAkHEBMOICYcQEw4gJhwADHhAGLCAcSEA4gJBxATDiAmHEDMX3Kry/YfK4OaWXEAMeEAYlvnL1ycegagMVYcQEw4gJhwADHhAGLCAcSEA4gJBxATDiAmHEBMOICYcAAx4QBiwgHEhAOICQcQEw4gJhxATDiAmHAAMeEAYsIBxIQDiAkHEBMOICYcQEw4gJhwADHhAGLCAcSEA4gdn3oAHvalr33r05/7YinlW9/9wcknPaGU8vybb/yXj/z7k5941ewJNzz92hfdctP3fvjjj//Hfz/00K+PHTv2F7ff+t0f/GjxrW565lNLKQc+88brTn728199x5tfs7W1VUr523d/8PWvuO3M2Xv/+cybdg52x9+8a26GDR0RaiUcFbnxupM3XneylPKGu9/9tje+cvaP7//4p7Yfz7zvY5/8q9edvuwxl3zhq9/8yCf+6y9f9ZLFtzr8M7/z/f/9/Fe+8SfPPvXlr3/nyssf+4Tfu2JxsOOPeMTce2ZwwtGeXzzw4C9/+atSyg3PuPbSSx695DNf+vybz37o/j9+1tM+8Z//89qXvXAdA9Mf4WjPy2593pl/vPdZp55y8w3POHXNE5d85u9fefkfXHXFB+779OMfd+mJKx+/npHpjXDU7lcPPfR3//Th2eOX33bLNVefeO5N199w3bVf+tq3/+3+zzzn+pN//oI/3ettD/nMl77g5rf+w/v+/q/vOPwMS7wgeiActZv7/sL/PfDgj37ys2v/8MTzbrr+j0495W3v+te9cnD4Z151xWWP+t1HXnXFZYecAdyObc3W1tkP3f/Tn/+ilPLAgxcuf+ylK3gmhKw4ardzm3DN1Sdeftstrz39wveeu/+Rv3P82LGtO26/da83vOTRjzrkMxc/4tvP3jt7fPJJJ25/8Z8tzrDEC6IHW+cvXJx6BqAxtipATDiAmHAAMeEAYsIBxIQDiAkHEBMOICYcQEw4gJhwADHhAGLCAcSEA4gJBxATDiAmHEBMOICYcAAx4QBiwgHEhAOICQcQEw4gJhxATDiAmHAAMeEAYsIBxIQDiAkHEBMOICYcQEw4gNj/A/xVSVk3//Y6AAAAAElFTkSuQmCC','base64');
  server=createServer((req,res)=>{if(req.url.includes('/attachments/')){res.setHeader('content-type','image/png');res.end(testPicture);return;}res.setHeader('content-type','text/html;charset=utf-8');res.end(html);});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});if(evidence)await mkdir(evidence,{recursive:true});
  const url=`http://127.0.0.1:${server.address().port}`;
  for(const width of [1280,1440])for(const pure of [false,true]){
    const page=await browser.newPage({viewport:{width,height:900},locale:'zh-CN'});page.on('pageerror',error=>errors.push(error.message));await page.goto(url+(pure?'?pure':''));
    await page.getByText('执行单价：40.000 元/件',{exact:true}).waitFor();
    if(!pure){await page.getByRole('combobox',{name:'销售年份',exact:true}).selectOption('2027');await page.getByRole('combobox',{name:'销售系列',exact:true}).selectOption('P05');await page.getByRole('combobox',{name:'辅料是否需要对色',exact:true}).selectOption('yes');}
    else assert.equal(await page.getByRole('combobox',{name:'销售年份',exact:true}).count(),0);
    assert.equal(await page.evaluate(()=>window.creationOptionsFixture.saved.document.sizes.length),0);
    await page.locator('#development-quantity').fill('2');
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    await page.evaluate(()=>window.scrollTo(0,0));
    if(evidence)await page.screenshot({path:join(evidence,`create-${pure?'pure':'order'}-${width}.png`),fullPage:true});
    await page.evaluate(()=>{window.creationOptionsFixture.failNextSave=true;});
    await page.getByRole('button',{name:'发布开发单',exact:true}).click();await page.getByRole('alert').filter({hasText:'TEST 保存失败'}).waitFor();
    if(!pure){assert.equal(await page.getByRole('combobox',{name:'销售年份',exact:true}).inputValue(),'2027');assert.equal(await page.getByRole('combobox',{name:'销售系列',exact:true}).inputValue(),'P05');}
    await page.getByRole('button',{name:'发布开发单',exact:true}).evaluate(button=>{button.click();button.click();});await page.getByRole('status').filter({hasText:'TEST 开发已发布'}).waitFor();
    const state=await page.evaluate(()=>window.creationOptionsFixture);assert.equal(state.created,1);assert.equal(state.orderId,null);assert.equal(state.saved.status,'published');assert.deepEqual(state.saved.document.sizes,[]);
    assert.equal(state.requests.filter(r=>r.path.endsWith('/development/publish')).length,1);assert.equal(state.requests.filter(r=>r.path.endsWith('/confirm')).length,0);
    if(!pure){assert.equal(state.saved.document.customerOrderDraft.order.salesYear,2027);assert.equal(state.saved.document.customerOrderDraft.order.salesSeries,'P05');assert.equal(state.saved.document.customerOrderDraft.order.requiresColorMatching,true);assert.equal(state.saved.document.customerOrderDraft.order.lines[0].customerWarehouseArrivalDate,'2027-03-15');}
    results.push({width,pure,checks:['optional sizes publish','formal confirmation deferred','save failure retains inputs','double click one publication','year/series do not change promise','no page overflow']});await page.close();
  }
  const preorderPage=await browser.newPage({viewport:{width:1280,height:900},locale:'zh-CN'});
  await preorderPage.goto(url+'?preorder');await preorderPage.getByRole('combobox',{name:'销售年份',exact:true}).selectOption('2027');
  await preorderPage.getByRole('button',{name:'保存预下单备料资料',exact:true}).click();await preorderPage.getByRole('status').filter({hasText:'开发资料与订购草稿已保存'}).waitFor();
  const preorderState=await preorderPage.evaluate(()=>window.creationOptionsFixture);assert.equal(preorderState.saved.document.customerOrderDraft.stage,'preorder');assert.equal(preorderState.saved.document.quantity,null);assert.equal(preorderState.saved.status,'draft');assert.equal(preorderState.requests.some(r=>r.path.endsWith('/development/publish')||r.path.endsWith('/confirm')),false);await preorderPage.close();
  for(const width of [1280,1440]){
    const restored=await browser.newPage({viewport:{width,height:900},locale:'zh-CN'});restored.on('pageerror',error=>errors.push(error.message));
    await restored.goto(url+'?missingDate');const promised=restored.locator('#development-po-date-1');
    await promised.waitFor();assert.equal(await promised.isDisabled(),false);await promised.fill('2027-03-15');
    await restored.evaluate(()=>{window.creationOptionsFixture.failNextConfirm=true;});
    await restored.getByRole('button',{name:'确认客户订单',exact:true}).click();await restored.getByRole('alert').filter({hasText:'TEST 确认失败'}).waitFor();
    assert.equal(await promised.inputValue(),'2027-03-15');assert.equal(await promised.isDisabled(),false);
    if(evidence){await restored.evaluate(()=>window.scrollTo(0,0));await restored.screenshot({path:join(evidence,`restore-date-retry-${width}.png`),fullPage:true});}
    await restored.getByRole('button',{name:'确认客户订单',exact:true}).click();await restored.getByRole('status').filter({hasText:'TEST 开发已发布'}).waitFor();
    const confirmed=await restored.evaluate(()=>window.creationOptionsFixture);assert.equal(confirmed.orderId,'00000000-0000-4000-8000-000000000008');
    assert.equal(confirmed.requests.filter(r=>r.path.endsWith('/development/publish')).length,0);
    assert.equal(confirmed.saved.document.customerOrderDraft.order.lines[0].customerWarehouseArrivalDate,null);results.push({width,scenario:'published missing promise',checks:['editable date','confirmation failure keeps input','retry confirms without republishing','published basis remains unchanged']});await restored.close();
  }
  const promotedPage=await browser.newPage({viewport:{width:1280,height:900},locale:'zh-CN'});
  await promotedPage.goto(url+'?preorderReady');await promotedPage.getByText('执行单价：40.000 元/件',{exact:true}).waitFor();
  await promotedPage.getByRole('button',{name:'无确定客户订单',exact:true}).click();
  await promotedPage.getByRole('button',{name:'发布开发单',exact:true}).click();await promotedPage.getByRole('status').filter({hasText:'TEST 开发已发布'}).waitFor();
  const promoted=await promotedPage.evaluate(()=>window.creationOptionsFixture);assert.equal(promoted.saved.document.customerOrderDraft.stage,'formal');assert.equal(promoted.saved.status,'published');assert.equal(promoted.orderId,null);results.push({width:1280,scenario:'preorder promotion',checks:['explicit development switch','formal stage saved','one development publication','no formal order invented']});await promotedPage.close();
  const page=await browser.newPage({viewport:{width:1280,height:900}});page.on('pageerror',error=>errors.push(error.message));await page.goto(url+'?fresh');
  await page.getByRole('textbox',{name:'设计款号',exact:true}).fill('TEST-NEW');await page.getByRole('button',{name:'检查业务ID',exact:true}).click();await page.getByRole('status').filter({hasText:'该编号当前可用'}).waitFor();
  await page.getByRole('textbox',{name:'设计款号',exact:true}).fill('TEST-USED');await page.getByRole('button',{name:'检查业务ID',exact:true}).click();await page.getByRole('status').filter({hasText:'该编号已有档案'}).waitFor();
  await page.goto(url+'?historical');assert.equal(await page.getByRole('combobox',{name:'销售年份',exact:true}).inputValue(),'2025');
  assert.deepEqual(await page.getByRole('combobox',{name:'销售年份',exact:true}).locator('option').allTextContents(),['请选择年份','2025','2026','2027']);await page.close();
  assert.deepEqual(errors,[]);
}finally{
  if(evidence)await writeFile(join(evidence,'result.json'),JSON.stringify({results,errors,limitations:['Actual product components and inherited styles, synthetic intercepted API; PostgreSQL semantics/authorization verified separately. No deployed system or true business data.']},null,2));
  await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));await rm(output,{recursive:true,force:true});
}
console.log(JSON.stringify({passed:results.length,errors}));
