import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Page} from 'playwright-core';
import {supplychainSettingsBrowser} from '../acceptance/supplychain-settings-browser.js';
import {DigitalProductionIdentityService} from '../../apps/api/src/production-platform/identity-service.js';
import {DigitalDevelopmentService} from '../../apps/api/src/production-platform/development-service.js';
import {initialDevelopmentDocument} from '../../apps/web/src/digital-development-editing.js';
import type {AuxiliaryItem} from '@dx-rework/contracts/auxiliary-catalog';

const url=process.env.TEST_DATABASE_URL;
async function createFromPage(page:Page,name:string){
 await page.getByRole('button',{name:'直接新增辅料',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'直接新增共享辅料',exact:true});
 await dialog.getByRole('textbox',{name:'辅料品名',exact:true}).fill(name);
 await dialog.getByRole('textbox',{name:'规格',exact:true}).fill('TEST 原规格');
 await dialog.getByRole('textbox',{name:'供应方',exact:true}).fill('TEST 原供应方');
 const receipt=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/master-data/auxiliaries'&&response.request().method()==='POST');
 await dialog.getByRole('button',{name:'保存共享目录',exact:true}).click();
 const response=await receipt;expect(response.status(),await response.text()).toBe(200);
 await dialog.waitFor({state:'hidden'});
 return await response.json() as AuxiliaryItem;
}

(url?describe.sequential:describe.skip)('shared auxiliary directory and original picker through signed App sessions',()=>{
 let h:Awaited<ReturnType<typeof supplychainSettingsBrowser>>;
 beforeAll(async()=>{h=await supplychainSettingsBrowser(url!,await mkdtemp(join(tmpdir(),'dx-auxiliary-native-')),{fullApp:true,auxiliaryCatalog:true});});
 afterAll(async()=>{if(h){await h.writeEvidence();await h.dispose();}});

 it('keeps the original five directory identities and direct URL, shows its list immediately, and denies unrelated staff',async()=>{
  for(const alias of ['sample-designer','merchandiser','production-management','owner','root']){
   const tab=await h.open(h.f.people[alias]!.actorId,1165,{},'/ui/auxiliary-catalog');
   try{
    await tab.page.getByRole('heading',{name:'共享辅料目录',exact:true,level:1}).waitFor();
    await tab.page.getByRole('button',{name:'直接新增辅料',exact:true}).waitFor({state:'visible'});
    expect(await tab.page.getByRole('table',{name:'共享辅料目录',exact:true}).count()).toBe(1);
    expect(await tab.page.getByRole('button',{name:'打开共享辅料目录',exact:true}).count()).toBe(0);
    expect(await tab.page.getByRole('dialog').count()).toBe(0);
    expect(await tab.page.getByRole('textbox',{name:'搜索品名、规格或供应方',exact:true}).evaluate(input=>input===document.activeElement)).toBe(false);
   }finally{await tab.close();}
  }
  for(const role of ['development_clerk','pmc']){
   const other=await h.dedicated(role),denied=await h.open(other.id,1165,{},'/ui/auxiliary-catalog');
   try{
    await denied.page.getByRole('heading',{name:'无权访问此页面',exact:true}).waitFor();
    expect(await denied.page.getByRole('table',{name:'共享辅料目录',exact:true}).count()).toBe(0);
    expect(await denied.page.evaluate(async id=>({list:(await fetch('/api/master-data/auxiliaries')).status,history:(await fetch(`/api/master-data/auxiliaries/${id}/versions`)).status}),randomUUID())).toEqual({list:403,history:403});
   }finally{await denied.close();}
  }
 });

 it('uses an old name to find the same effective item and version from the directory and new sheet while preserving the old sheet snapshot',async()=>{
  const designer=h.f.people['sample-designer']!,tab=await h.open(designer.actorId,1165,{},'/ui/auxiliary-catalog');
  let old:AuxiliaryItem,current:AuxiliaryItem;
  const forms=new DigitalDevelopmentService(h.db,true),identity=new DigitalProductionIdentityService(h.db,true);
  const source=async(name:string,entry?:AuxiliaryItem)=>{
   const created=await identity.createSource(designer,{designStyleNo:name,temporaryStyleNo:null,customerCode:'PD',developmentType:'头版'},randomUUID(),true);
   const photo=await h.f.image(designer),materialId=randomUUID();
   const document={...initialDevelopmentDocument(),materials:[{materialId,category:'辅料' as const,label:'TEST辅料',name:entry?.name??'TEST 待选料',specification:entry?.specification??'',supplier:entry?.supplier??'',auxiliaryKind:entry?.auxiliaryKind??'普通辅料' as const,...(entry?{auxiliaryCatalog:{id:entry.id,version:entry.version}}:{}),width:'',weight:'',composition:'',consumption:'',color:'TEST 黑',quantity:'1',requiredThisRound:false,available:false,expectedDate:null}],files:[{attachmentId:photo,kind:'款图' as const}]};
   const saved=await forms.save(designer,created.sourceId,{expectedVersion:0,document},randomUUID());
   return {...created,materialId,saved};
  };
  try{
   old=await createFromPage(tab.page,'TEST-旧目录-'+randomUUID());
   const original=await source('TEST-目录旧快照-'+randomUUID(),old);
   await tab.page.getByRole('textbox',{name:'搜索品名、规格或供应方',exact:true}).fill(old.name);
   const row=tab.page.getByRole('row').filter({hasText:old.name});
   await row.getByRole('button',{name:'改名',exact:true}).click();
   const editor=tab.page.getByRole('dialog',{name:'改名',exact:true});
   await editor.getByRole('textbox',{name:'辅料品名',exact:true}).fill('TEST-新目录-'+randomUUID());
   await editor.getByRole('textbox',{name:'本次变更原因',exact:true}).fill('TEST 保留原目录快照');
   const renamed=tab.page.waitForResponse(response=>new URL(response.url()).pathname===`/api/master-data/auxiliaries/${old.id}/versions`&&response.request().method()==='POST');
   await editor.getByRole('button',{name:'保存共享目录',exact:true}).click();
   const response=await renamed;expect(response.status(),await response.text()).toBe(200);current=await response.json();await editor.waitFor({state:'hidden'});
   const directory=await tab.page.evaluate(async name=>{const r=await fetch('/api/master-data/auxiliaries?'+new URLSearchParams({q:name}));if(!r.ok)throw Error('Directory read failed '+r.status);return r.json();},old.name);
   expect(directory.items).toEqual([current]);
   for(const width of [1165,1920,390]){
    await tab.page.setViewportSize({width,height:900});
    const bounds=await tab.page.locator('.auxiliary-catalog-page').evaluate(element=>({right:element.getBoundingClientRect().right,viewport:innerWidth}));
    expect(bounds.right).toBeLessThanOrEqual(bounds.viewport+1);
    await tab.page.screenshot({path:join(h.evidence,`directory-${width}.png`),fullPage:true});
    if(width===390){
     const scroller=tab.page.locator('.auxiliary-catalog-page > .auxiliary-catalog-table');
     await scroller.evaluate(element=>{element.scrollLeft=element.scrollWidth;});
     const button=tab.page.getByRole('row').filter({hasText:current.name}).getByRole('button',{name:'版本历史',exact:true});
     const box=await button.boundingBox();expect(box).toBeTruthy();expect(box!.x).toBeGreaterThanOrEqual(0);expect(box!.x+box!.width).toBeLessThanOrEqual(width+1);
     await scroller.evaluate(element=>{element.scrollLeft=0;});
    }
   }
   await tab.page.setViewportSize({width:1165,height:900});
   const currentRow=tab.page.getByRole('row').filter({hasText:current.name});await currentRow.getByRole('button',{name:'版本历史',exact:true}).click();
   const history=tab.page.getByRole('dialog',{name:current.name+' · 版本历史',exact:true});
   await history.getByRole('cell',{name:old.name,exact:true}).waitFor();await history.getByRole('cell',{name:current.name,exact:true}).waitFor();
   await history.getByRole('button',{name:'关闭版本历史',exact:true}).click();
   const oldTab=await h.open(designer.actorId,1165,{},'/ui/digital-production?development='+original.sourceId);
   try{
    await oldTab.page.getByRole('button',{name:'面辅料',exact:true}).click();
    expect(await oldTab.page.getByRole('textbox',{name:'辅料品名（材料资料）',exact:true}).inputValue()).toBe(old.name);
    expect(await oldTab.page.getByRole('textbox',{name:'辅料规格（选填）',exact:true}).inputValue()).toBe(old.specification);
    const detail=oldTab.page.locator('details.development-material-details').first();
    if(await detail.getAttribute('open')===null)await detail.locator('summary').click();
    const supplier=oldTab.page.locator(`#development-${original.materialId}-supplier`);
    expect(await supplier.isVisible()).toBe(true);expect(await supplier.inputValue()).toBe(old.supplier);
    expect((await forms.read(designer,original.sourceId)).document).toEqual(original.saved.document);
   }finally{await oldTab.close();}
   const next=await source('TEST-新单选料-'+randomUUID()),newTab=await h.open(designer.actorId,1165,{},'/ui/digital-production?development='+next.sourceId);
   try{
    const page=newTab.page;await page.getByRole('button',{name:'面辅料',exact:true}).click();await page.getByRole('button',{name:'选择共享辅料 1',exact:true}).click();
    const picker=page.getByRole('dialog',{name:'共享辅料',exact:true});
    const picked=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/master-data/auxiliaries'&&new URL(response.url()).searchParams.get('q')===old.name);
    await picker.getByRole('textbox',{name:'搜索品名、规格或供应方',exact:true}).fill(old.name);
    expect((await (await picked).json()).items).toEqual([current]);
    await picker.getByRole('button',{name:'选择此辅料',exact:true}).click();await picker.waitFor({state:'hidden'});
    expect(await page.getByRole('textbox',{name:'辅料品名（材料资料）',exact:true}).inputValue()).toBe(current.name);
    const savedResponse=page.waitForResponse(response=>new URL(response.url()).pathname===`/api/digital-production/sources/${next.sourceId}/development`&&response.request().method()==='PUT');
    await page.getByRole('button',{name:'保存开发资料草稿',exact:true}).click();
    const saved=await savedResponse;expect(saved.status(),await saved.text()).toBe(200);
    const actual=(await forms.read(designer,next.sourceId)).document!;
    expect(actual.materials[0]).toMatchObject({materialId:next.materialId,name:current.name,specification:current.specification,supplier:current.supplier,auxiliaryCatalog:{id:current.id,version:current.version},available:false,requiredThisRound:false,color:'TEST 黑'});
    expect(actual.files).toEqual(next.saved.document!.files);
    expect((await forms.read(designer,original.sourceId)).document).toEqual(original.saved.document);
   }finally{await newTab.close();}
   const keeper=await createFromPage(tab.page,'TEST-保留目录-'+randomUUID());
   await tab.page.getByRole('textbox',{name:'搜索品名、规格或供应方',exact:true}).fill(old.name);
   await tab.page.getByRole('row').filter({hasText:current.name}).getByRole('button',{name:'合并重复项',exact:true}).click();
   const merge=tab.page.getByRole('dialog',{name:'合并重复项',exact:true});
   await merge.getByRole('textbox',{name:'搜索合并目标',exact:true}).fill(keeper.name);
   await merge.getByRole('row').filter({hasText:keeper.name}).getByRole('button',{name:'作为合并目标',exact:true}).click();
   await merge.getByRole('textbox',{name:'本次变更原因',exact:true}).fill('TEST 合并真实重复项');
   const merged=tab.page.waitForResponse(response=>new URL(response.url()).pathname===`/api/master-data/auxiliaries/${current.id}/merge`&&response.request().method()==='POST');
   await merge.getByRole('button',{name:'保存共享目录',exact:true}).click();
   const mergeResponse=await merged;expect(mergeResponse.status(),await mergeResponse.text()).toBe(200);expect(await mergeResponse.json()).toMatchObject({id:current.id,version:3,active:false,mergedInto:keeper.id});await merge.waitFor({state:'hidden'});
   expect((await forms.read(designer,original.sourceId)).document).toEqual(original.saved.document);
   await tab.page.getByRole('textbox',{name:'搜索品名、规格或供应方',exact:true}).fill(old.name);
   const keeperRow=tab.page.getByRole('row').filter({hasText:keeper.name});
   await keeperRow.getByRole('button',{name:'停用',exact:true}).click();
   const disable=tab.page.getByRole('dialog',{name:'停用',exact:true});
   await disable.getByRole('textbox',{name:'本次变更原因',exact:true}).fill('TEST 保留旧资料后停用');
   const disabled=tab.page.waitForResponse(response=>new URL(response.url()).pathname===`/api/master-data/auxiliaries/${keeper.id}/disable`&&response.request().method()==='POST');
   await disable.getByRole('button',{name:'保存共享目录',exact:true}).click();
   const disableResponse=await disabled;expect(disableResponse.status(),await disableResponse.text()).toBe(200);expect(await disableResponse.json()).toMatchObject({id:keeper.id,version:2,active:false});await disable.waitFor({state:'hidden'});
   await tab.page.getByText('没有匹配的辅料。',{exact:false}).waitFor();
   expect((await forms.read(designer,original.sourceId)).document).toEqual(original.saved.document);
  }finally{await tab.close();}
 });

 it('keeps the old rows while a new filter is pending and prevents a jump using the old total, including Enter',async()=>{
  const designer=h.f.people['sample-designer']!,tab=await h.open(designer.actorId,1165,{},'/ui/auxiliary-catalog');
  let release!:()=>void;
  const held=new Promise<void>(resolve=>{release=resolve;}),requested:string[]=[];
  try{
   const page=tab.page;
   await page.evaluate(async()=>{
    for(let index=0;index<16;index++){
     const response=await fetch('/api/master-data/auxiliaries',{method:'POST',headers:{'content-type':'application/json','idempotency-key':crypto.randomUUID()},body:JSON.stringify({name:'TEST-PAGE-'+crypto.randomUUID(),specification:'TEST',supplier:'TEST',auxiliaryKind:'普通辅料'})});
     if(!response.ok)throw Error('Native catalog setup failed '+response.status);
    }
   });
   await page.reload();
   const pagination=page.getByRole('navigation',{name:'辅料目录分页',exact:true});
   await pagination.getByRole('button',{name:'下一页',exact:true}).waitFor();
   await expect.poll(()=>pagination.getByRole('button',{name:'下一页',exact:true}).isEnabled()).toBe(true);
   page.on('request',request=>{if(new URL(request.url()).pathname==='/api/master-data/auxiliaries')requested.push(request.url());});
   await page.route('**/api/master-data/auxiliaries?**',async route=>{
    if(new URL(route.request().url()).searchParams.get('includeInactive')==='true')await held;
    await route.continue();
   });
   await page.getByRole('checkbox',{name:'显示停用及已合并记录',exact:true}).check();
   expect(await pagination.getByRole('button',{name:'跳转',exact:true}).isDisabled()).toBe(true);
   expect(await pagination.getByRole('button',{name:'下一页',exact:true}).isDisabled()).toBe(true);
   const input=pagination.getByRole('textbox',{name:'跳转页码',exact:true});
   await input.evaluate(element=>{(element as HTMLInputElement).value='2';element.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));});
   expect(requested.some(value=>new URL(value).searchParams.get('page')==='2')).toBe(false);
   release();
   await expect.poll(()=>pagination.getByRole('button',{name:'下一页',exact:true}).isEnabled()).toBe(true);
   const loaded=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/master-data/auxiliaries'&&new URL(response.url()).searchParams.get('page')==='2'&&new URL(response.url()).searchParams.get('includeInactive')==='true');
   await pagination.getByRole('button',{name:'下一页',exact:true}).click();
   const response=await loaded;expect(response.status(),await response.text()).toBe(200);
   const next=await response.json();expect(next.page).toBe(2);expect(next.items.length).toBeGreaterThan(0);
   await page.getByRole('table',{name:'共享辅料目录',exact:true}).getByRole('cell',{name:next.items[0].name,exact:true}).waitFor();
   await expect.poll(()=>requested.some(value=>new URL(value).searchParams.get('page')==='2'&&new URL(value).searchParams.get('includeInactive')==='true')).toBe(true);
   await page.goto('about:blank');await page.goBack();
   await page.getByRole('table',{name:'共享辅料目录',exact:true}).getByRole('cell',{name:next.items[0].name,exact:true}).waitFor();
   expect(new URL(page.url()).searchParams.get('page')).toBe('2');
   expect(await page.getByRole('checkbox',{name:'显示停用及已合并记录',exact:true}).isChecked()).toBe(true);
  }finally{release();await tab.close();}
 });
 it('recovers a failed directory read and a committed-but-lost write without duplicate creation, with dirty editor protection',async()=>{
  const designer=h.f.people['sample-designer']!,tab=await h.open(designer.actorId,1165,{failRead:true,readPath:'/api/master-data/auxiliaries?q=&page=1&includeInactive=false',losePath:'/api/master-data/auxiliaries'},'/ui/auxiliary-catalog');
  try{
   const page=tab.page;await page.getByRole('button',{name:'重新读取目录',exact:true}).click();
   await page.getByRole('button',{name:'直接新增辅料',exact:true}).click();
   const editor=page.getByRole('dialog',{name:'直接新增共享辅料',exact:true}),name='TEST-目录回执-'+randomUUID();
   await editor.getByRole('textbox',{name:'辅料品名',exact:true}).fill(name);
   await editor.getByRole('button',{name:'取消本次编辑',exact:true}).click();
   const confirmation=page.getByRole('dialog').filter({hasText:'目录资料尚未保存'});
   await confirmation.getByRole('button',{name:'取消',exact:true}).click();
   expect(await editor.getByRole('textbox',{name:'辅料品名',exact:true}).inputValue()).toBe(name);
   await editor.getByRole('button',{name:'保存共享目录',exact:true}).click();
   await editor.getByRole('button',{name:'核对原目录回执',exact:true}).click();
   await editor.waitFor({state:'hidden'});
   expect((await h.db.query('SELECT count(*) n FROM auxiliary_catalog_items WHERE name=$1',[name])).rows[0].n).toBe('1');
   const writes=h.requests.filter(row=>row.session===tab.session&&row.method==='POST'&&row.path==='/api/master-data/auxiliaries');expect(writes).toHaveLength(1);
   expect(h.requests.some(row=>row.session===tab.session&&row.path.startsWith('/api/master-data/auxiliaries/receipt?'))).toBe(true);
  }finally{await tab.close();}
 });
});
