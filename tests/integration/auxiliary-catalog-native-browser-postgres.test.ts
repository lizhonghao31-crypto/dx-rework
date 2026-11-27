import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Page} from 'playwright-core';
import {supplychainSettingsBrowser} from '../acceptance/supplychain-settings-browser.js';
import {AuxiliaryCatalogService} from '../../apps/api/src/access/auxiliary-catalog-service.js';
import {DigitalProductionIdentityService} from '../../apps/api/src/production-platform/identity-service.js';
import {DigitalDevelopmentService} from '../../apps/api/src/production-platform/development-service.js';
import {initialDevelopmentDocument} from '../../apps/web/src/digital-development-editing.js';
import type {AuxiliaryItem} from '@dx-rework/contracts/auxiliary-catalog';
import {chooseDevelopmentCreation} from './development-creation-browser-steps.js';
import {CreateSupplierSchema} from '@dx-rework/contracts';

const url=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
async function createFromPage(page:Page,name:string,price?:{amount:string;unit:string}){
 await page.getByRole('button',{name:'新增辅料',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'新增辅料',exact:true});
 await dialog.getByRole('textbox',{name:'辅料品名',exact:true}).fill(name);
 await dialog.getByRole('textbox',{name:'规格',exact:true}).fill('TEST 原规格');
 expect(await dialog.getByRole('textbox',{name:/供应方|供应商/}).count()).toBe(0);
 if(price){
  await dialog.getByRole('textbox',{name:'参考单价（人民币、不含税）',exact:true}).fill(price.amount);
  await dialog.getByRole('textbox',{name:'参考价计价单位',exact:true}).fill(price.unit);
 }
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

 it('does not accept an independently typed supplier in the auxiliary directory',async()=>{
  const designer=h.f.people['sample-designer']!,tab=await h.open(designer.actorId,1165,{},'/ui/auxiliary-catalog');
  try{
   const name='TEST-无辅料目录供应商-'+randomUUID();
   const rejected=await tab.page.evaluate(async name=>{
    const response=await fetch('/api/master-data/auxiliaries',{method:'POST',headers:{'content-type':'application/json','idempotency-key':crypto.randomUUID()},body:JSON.stringify({name,specification:'TEST',supplier:'TEST 未选供应方',auxiliaryKind:'普通辅料'})});
    return {status:response.status,body:await response.json()};
   },name);
   expect(rejected.status,JSON.stringify(rejected.body)).toBe(400);
   expect((await h.db.query('SELECT count(*) n FROM auxiliary_catalog_items WHERE name=$1',[name])).rows[0].n).toBe('0');
  }finally{await tab.close();}
 });

 it('saves the numbered C2 draft with an exact C3 reference and a separately chosen order supplier',async()=>{
  const joined=await supplychainSettingsBrowser(url!,await mkdtemp(join(tmpdir(),'dx-c3-numbered-picker-')),{fullApp:true,auxiliaryCatalog:true,workbenchNumberedCreation:true,orderTimeFlow:true,orderTimeModel:true});
  try{
   const designer=joined.f.people['sample-designer']!,supplierName='TEST C3 订单供应商',supplierCode='TEST-C3-FABRIC';
   const supplier=await joined.f.access.createSupplier(joined.f.root,CreateSupplierSchema.parse({supplierCode,supplierName,supplierType:'fabric',changeReason:'TEST 从原供应商目录选择'}));
   const tab=await joined.open(designer.actorId,1165,{},'/ui/auxiliary-catalog');
   try{
    const {page}=tab,entry=await createFromPage(page,'TEST-C3-独立供应商-'+randomUUID(),{amount:'2.35',unit:'个'});
    expect(entry).not.toHaveProperty('supplier');
    await page.goto(new URL('/ui/digital-production?workspace=designer&section=create',page.url()).href);
    await page.getByRole('button',{name:'新建开发订单',exact:true}).click();
    await chooseDevelopmentCreation(page,'纯开发');
    const materials=page.locator('#development-materials');
    await materials.getByRole('button',{name:/添加辅料/}).click();
    const shared=materials.getByRole('button',{name:'选择辅料 4',exact:true}),row=materials.getByRole('region',{name:'辅料 4',exact:true});
    await shared.scrollIntoViewIfNeeded();
    const originalUrl=page.url();
    await shared.click();
    const picker=page.getByRole('dialog',{name:'辅料选择',exact:true});
    await picker.getByRole('table',{name:'辅料目录',exact:true}).waitFor();
    const full=await picker.boundingBox();expect(full!.width).toBeGreaterThan(1050);
    expect(page.url()).toBe(originalUrl);
    await picker.getByRole('textbox',{name:'搜索品名或规格',exact:true}).fill(entry.name);
    await picker.getByText(entry.name,{exact:true}).waitFor();
    await picker.getByRole('button',{name:'选择此辅料',exact:true}).click();await picker.waitFor({state:'hidden'});
    const supplierButton=row.getByRole('button',{name:'辅料 供应商',exact:true});
    expect(await supplierButton.innerText()).toBe('选择面辅料供应商');
    await supplierButton.click();
    const suppliers=page.getByRole('dialog',{name:'选择面辅料供应商',exact:true});
    await suppliers.getByRole('textbox',{name:'搜索面辅料供应商',exact:true}).fill(supplierName);
    await suppliers.getByRole('button',{name:`${supplierName} · ${supplierCode}`,exact:true}).click();await suppliers.waitFor({state:'hidden'});
    expect(page.url()).toBe(originalUrl);
    const amount=row.getByRole('textbox',{name:/辅料 数量$/});
    await amount.fill('12');
    await row.getByRole('combobox',{name:/辅料 数量单位/}).click();
    await page.getByRole('option',{name:'个',exact:true}).click();
    const price=row.getByRole('textbox',{name:/辅料 单价/});
    expect(await price.inputValue()).toBe('2.35');await price.fill('0.8');
    await row.getByText('9.6 元',{exact:true}).waitFor();
    const reserved=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname.endsWith('/sources/numbered-drafts'));
    const saved=page.waitForResponse(r=>r.request().method()==='PUT'&&/\/sources\/[a-f0-9-]+\/development$/.test(new URL(r.url()).pathname));
    await page.getByRole('button',{name:'保存开发资料草稿',exact:true}).click();
    const reservation=await reserved;expect(reservation.status(),await reservation.text()).toBe(200);
    const {sourceId,orderNumber}=await reservation.json();expect(orderNumber).toBeNull();
    const response=await saved;expect(response.status(),await response.text()).toBe(200);
    const draft=await response.json(),expected={name:entry.name,specification:entry.specification,supplier:supplierName,
     supplierReference:supplier,auxiliaryCatalog:{id:entry.id,version:entry.version,referencePricing:entry.referencePricing},unitPrice:'0.8',quantity:'12',quantityUnit:'个',pricingUnit:'个'};
    expect(draft).toMatchObject({sourceId,status:'draft',document:{materialSupplierCatalog:true}});
    expect(draft.document.materials[3]).toMatchObject(expected);
    await page.getByText(/^开发资料与订购草稿已保存/).waitFor();
    await page.reload();await row.waitFor();
    expect(await row.getByRole('textbox',{name:/辅料 品名/}).inputValue()).toBe(entry.name);
    expect(await supplierButton.innerText()).toBe(supplierName);expect(await price.inputValue()).toBe('0.8');
    const invalid=await page.evaluate(async({sourceId,version,document})=>{
     document.materials[3].supplier='TEST 不在供应商库';delete document.materials[3].supplierReference;
     const response=await fetch(`/api/digital-production/sources/${sourceId}/development`,{method:'PUT',headers:{'content-type':'application/json','idempotency-key':crypto.randomUUID()},body:JSON.stringify({expectedVersion:version,document})});
     return {status:response.status,body:await response.json()};
    },draft);
    expect(invalid.status,JSON.stringify(invalid.body)).toBe(400);
    expect(JSON.stringify(invalid.body)).toContain('请选择有效的面辅料供应商');
    const actual=await new DigitalDevelopmentService(joined.db,true).read(designer,sourceId);
    expect(actual.version).toBe(draft.version);expect(actual.document!.materials[3]).toMatchObject(expected);
    const directory=await page.evaluate(async(name)=>{const r=await fetch('/api/master-data/auxiliaries?'+new URLSearchParams({q:name}));return r.json();},entry.name);
    expect(directory.items).toEqual([entry]);
   }finally{await tab.close();}
  }finally{await joined.writeEvidence();await joined.dispose();}
 });

 it('keeps the original five directory identities and direct URL, shows its list immediately, and denies unrelated staff',async()=>{
  for(const alias of ['sample-designer','merchandiser','production-management','owner','root']){
   const tab=await h.open(h.f.people[alias]!.actorId,1165,{},'/ui/auxiliary-catalog');
   try{
    await tab.page.getByRole('heading',{name:'共享辅料目录',exact:true,level:1}).waitFor();
    await tab.page.getByRole('button',{name:'新增辅料',exact:true}).waitFor({state:'visible'});
    expect(await tab.page.getByRole('table',{name:'共享辅料目录',exact:true}).count()).toBe(1);
    expect(await tab.page.getByRole('button',{name:'打开共享辅料目录',exact:true}).count()).toBe(0);
    expect(await tab.page.getByRole('dialog').count()).toBe(0);
    expect(await tab.page.getByRole('textbox',{name:'搜索品名或规格',exact:true}).evaluate(input=>input===document.activeElement)).toBe(false);
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
  const source=async(name:string,entry?:AuxiliaryItem,active=false)=>{
   const created=await identity.createSource(designer,{designStyleNo:name,temporaryStyleNo:null,customerCode:'PD',developmentType:'头版'},randomUUID(),true);
   const photo=await h.f.image(designer),materialId=randomUUID();
   const document={...initialDevelopmentDocument(),...(active?{quantity:1}:{}),materials:[{materialId,category:'辅料' as const,label:'TEST辅料',name:entry?.name??'TEST 待选料',specification:entry?.specification??'',supplier:entry?'TEST 原订单供应商':'',auxiliaryKind:entry?.auxiliaryKind??'普通辅料' as const,
    ...(entry?{auxiliaryCatalog:{id:entry.id,version:entry.version,referencePricing:entry.referencePricing}}:{}),
    ...(entry?.referencePricing?{unitPrice:entry.referencePricing.amount,pricingUnit:entry.referencePricing.unit}:{}),
    width:'',weight:'',composition:'',consumption:'',color:'TEST 黑',quantity:'1',requiredThisRound:false,available:false,expectedDate:active?'2027-01-01':null}],files:[{attachmentId:photo,kind:'款图' as const}]};
   const saved=await forms.save(designer,created.sourceId,{expectedVersion:0,document},randomUUID());
   if(active)expect((await forms.publish(designer,created.sourceId,saved.version,randomUUID())).status).toBe('published');
   return {...created,materialId,saved};
  };
  try{
   old=await createFromPage(tab.page,'TEST-旧目录中文长名称用于验证辅料品名不被截断和操作仍按两行展示-'+randomUUID(),{amount:'0',unit:'套'});
   const original=await source('TEST-目录旧快照-'+randomUUID(),old);
   const adopted=await source('TEST-已发布的目录采用依据-'+randomUUID(),old,true);
   await tab.page.getByRole('textbox',{name:'搜索品名或规格',exact:true}).fill(old.name);
   const row=tab.page.getByRole('row').filter({hasText:old.name});
   await row.getByRole('cell',{name:'0 元 / 套',exact:true}).waitFor();
   const table=tab.page.getByRole('table',{name:'共享辅料目录',exact:true});
   expect(await table.getByRole('columnheader').allTextContents()).toEqual(['名称','种类','规格','参考价 / 单位','版本','状态','操作']);
   for(const viewport of [{width:1165,height:747},{width:1440,height:900}]){
    await tab.page.setViewportSize(viewport);
    const positions=await Promise.all(['改名','修改参考价','停用','版本历史'].map(name=>row.getByRole('button',{name,exact:true}).boundingBox()));
    const [rename,price,disable,history]=positions.map(box=>{expect(box).not.toBeNull();return box!;});
    expect(rename.y).toBeCloseTo(price.y,1);expect(disable.y).toBeCloseTo(history.y,1);
    expect(rename.x).toBeCloseTo(disable.x,1);expect(price.x).toBeCloseTo(history.x,1);expect(disable.y).toBeGreaterThan(rename.y);
    expect(await tab.page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
    await tab.page.screenshot({path:join(h.evidence,`catalog-table-${viewport.width}.png`)});
   }
   await row.getByRole('button',{name:'改名',exact:true}).click();
   const editor=tab.page.getByRole('dialog',{name:'改名',exact:true});
   await editor.getByRole('textbox',{name:'辅料品名',exact:true}).fill('TEST-新目录-'+randomUUID());
   await editor.getByRole('textbox',{name:'本次变更原因',exact:true}).fill('TEST 保留原目录快照');
   const renamed=tab.page.waitForResponse(response=>new URL(response.url()).pathname===`/api/master-data/auxiliaries/${old.id}/versions`&&response.request().method()==='POST');
   await editor.getByRole('button',{name:'保存共享目录',exact:true}).click();
   const response=await renamed;expect(response.status(),await response.text()).toBe(200);current=await response.json();await editor.waitFor({state:'hidden'});
   await tab.page.getByRole('row').filter({hasText:current.name}).getByRole('button',{name:'修改参考价',exact:true}).click();
   const pricing=tab.page.getByRole('dialog',{name:'修改参考价',exact:true});
   await pricing.getByRole('textbox',{name:'参考单价（人民币、不含税）',exact:true}).fill('2.35');
   await pricing.getByRole('textbox',{name:'参考价计价单位',exact:true}).fill('枚');
   await pricing.getByRole('textbox',{name:'本次变更原因',exact:true}).fill('TEST 参考价改版');
   const priced=tab.page.waitForResponse(r=>new URL(r.url()).pathname===`/api/master-data/auxiliaries/${old.id}/reference-pricing`&&r.request().method()==='POST');
   await pricing.getByRole('button',{name:'保存共享目录',exact:true}).click();
   const confirmed=await priced;expect(confirmed.status(),await confirmed.text()).toBe(200);current=await confirmed.json();
   expect(current.referencePricing).toEqual({amount:'2.35',unit:'枚'});
   await pricing.waitFor({state:'hidden'});
   await tab.page.getByRole('row').filter({hasText:current.name}).getByRole('cell',{name:'2.4 元 / 枚',exact:true}).waitFor();
   const directory=await tab.page.evaluate(async name=>{const r=await fetch('/api/master-data/auxiliaries?'+new URLSearchParams({q:name}));if(!r.ok)throw Error('Directory read failed '+r.status);return r.json();},old.name);
   expect(directory.items).toEqual([current]);
   const adoptedTab=await h.open(designer.actorId,1165,{},'/ui/digital-production?'+new URLSearchParams({
    workspace:'designer',section:'workspace',development:adopted.sourceId,area:'records',originalStage:'development',originalCategory:'auxiliary_basis',
   }));
   try{
    const originals=adoptedTab.page.getByLabel('按阶段读取原单据',{exact:true});
    const exactHistory=(url:string)=>new URL(url).pathname===`/api/master-data/auxiliaries/${old.id}/versions`&&new URL(url).searchParams.get('version')===String(old.version);
    let historyReads=0;
    adoptedTab.page.on('request',request=>{if(exactHistory(request.url()))historyReads++;});
    const control=originals.getByRole('button',{name:`${old.name} · 版本 ${old.version}`,exact:true});
    await control.waitFor();
    const [exact]=await Promise.all([
     adoptedTab.page.waitForResponse(response=>exactHistory(response.url())),
     control.click(),
    ]);
    expect(exact.status()).toBe(200);expect(await exact.json()).toMatchObject({total:1,items:[{id:old.id,version:old.version,name:old.name}]});
    const originalBasis=adoptedTab.page.getByRole('dialog',{name:`${old.name} · 采用版本 ${old.version}`,exact:true});
    await originalBasis.getByRole('cell',{name:old.name,exact:true}).waitFor();
    expect(await originalBasis.getByRole('columnheader',{name:/供应方|供应商/}).count()).toBe(0);
    expect(await originalBasis.getByRole('cell',{name:current.name,exact:true}).count()).toBe(0);
    await originalBasis.getByRole('button',{name:'关闭版本历史',exact:true}).click();await originalBasis.waitFor({state:'hidden'});
    await originals.getByRole('button',{name:'尺寸表',exact:true}).click();
    await originals.getByRole('button',{name:'采用的共享辅料版本',exact:true}).click();
    await control.click();await originalBasis.getByRole('cell',{name:old.name,exact:true}).waitFor();
    expect(historyReads).toBe(1);
    await originalBasis.getByRole('button',{name:'关闭版本历史',exact:true}).click();await originalBasis.waitFor({state:'hidden'});
    expect(new URL(adoptedTab.page.url()).searchParams.get('development')).toBe(adopted.sourceId);
   }finally{await adoptedTab.close();}
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
   await history.getByRole('cell',{name:old.name,exact:true}).waitFor();
   expect(await history.getByRole('cell',{name:current.name,exact:true}).count()).toBe(2);
   await history.getByRole('row').filter({hasText:old.name}).getByRole('cell',{name:'0 元 / 套',exact:true}).waitFor();
   await history.getByRole('cell',{name:'2.35 元 / 枚',exact:true}).waitFor();
   await history.getByRole('button',{name:'关闭版本历史',exact:true}).click();
   const oldTab=await h.open(designer.actorId,1165,{},'/ui/digital-production?development='+original.sourceId);
   try{
    await oldTab.page.getByRole('button',{name:'面辅料',exact:true}).click();
    expect(await oldTab.page.getByRole('textbox',{name:'辅料品名（材料资料）',exact:true}).inputValue()).toBe(old.name);
    expect(await oldTab.page.getByRole('textbox',{name:'辅料规格（选填）',exact:true}).inputValue()).toBe(old.specification);
    const detail=oldTab.page.locator('details.development-material-details').first();
    if(await detail.getAttribute('open')===null)await detail.locator('summary').click();
    const supplier=oldTab.page.locator(`#development-${original.materialId}-supplier`);
    expect(await supplier.isVisible()).toBe(true);expect(await supplier.inputValue()).toBe('TEST 原订单供应商');
    expect(await oldTab.page.locator(`#development-${original.materialId}-unitPrice`).inputValue()).toBe('0');
    expect((await forms.read(designer,original.sourceId)).document).toEqual(original.saved.document);
    await oldTab.page.getByRole('button',{name:'选择共享辅料 1',exact:true}).click();
    const picker=oldTab.page.getByRole('dialog',{name:'共享辅料',exact:true});
    await picker.getByRole('textbox',{name:'搜索品名或规格',exact:true}).fill(current.name);
    const option=picker.getByText(current.name,{exact:true});await option.waitFor();
    const choose=picker.getByRole('button',{name:'选择此辅料',exact:true});await choose.click();
    const adopt=oldTab.page.getByRole('dialog',{name:'确认操作',exact:true});
    await adopt.getByText(/0 元 \/ 套.*2\.35 元 \/ 枚/).waitFor();
    await adopt.getByRole('button',{name:'取消',exact:true}).click();await picker.waitFor();
    await choose.click();await adopt.getByRole('button',{name:'确认',exact:true}).click();await picker.waitFor({state:'hidden'});
    expect(await oldTab.page.locator(`#development-${original.materialId}-unitPrice`).inputValue()).toBe('2.35');
    expect(await supplier.inputValue()).toBe('TEST 原订单供应商');
    expect((await forms.read(designer,original.sourceId)).document).toEqual(original.saved.document);
   }finally{await oldTab.close();}
   const next=await source('TEST-新单选料-'+randomUUID()),newTab=await h.open(designer.actorId,1165,{},'/ui/digital-production?development='+next.sourceId);
   try{
    const page=newTab.page;await page.getByRole('button',{name:'面辅料',exact:true}).click();
    const materialName=page.getByRole('textbox',{name:'辅料品名（材料资料）',exact:true});
    const orderPrice=page.locator(`#development-${next.materialId}-unitPrice`),priceUnit=page.locator(`#development-${next.materialId}-pricingUnit`);
    await materialName.fill('');
    await orderPrice.fill('0');await priceUnit.fill('枚');
    await materialName.pressSequentially('TEST manual auxiliary');
    expect(await orderPrice.inputValue()).toBe('0');
    expect(await priceUnit.inputValue()).toBe('枚');
    await page.getByRole('textbox',{name:'辅料规格（选填）',exact:true}).fill('TEST changed specification');
    expect(await orderPrice.inputValue()).toBe('');
    expect(await priceUnit.inputValue()).toBe('');
    await page.getByRole('button',{name:'选择共享辅料 1',exact:true}).click();
    const picker=page.getByRole('dialog',{name:'共享辅料',exact:true});
    const picked=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/master-data/auxiliaries'&&new URL(response.url()).searchParams.get('q')===old.name);
    await picker.getByRole('textbox',{name:'搜索品名或规格',exact:true}).fill(old.name);
    expect((await (await picked).json()).items).toEqual([current]);
    await picker.getByRole('button',{name:'选择此辅料',exact:true}).click();await picker.waitFor({state:'hidden'});
    expect(await page.getByRole('textbox',{name:'辅料品名（材料资料）',exact:true}).inputValue()).toBe(current.name);
    expect(await orderPrice.inputValue()).toBe('2.35');
    await orderPrice.fill('3.5');
    const savedResponse=page.waitForResponse(response=>new URL(response.url()).pathname===`/api/digital-production/sources/${next.sourceId}/development`&&response.request().method()==='PUT');
    await page.getByRole('button',{name:'保存开发资料草稿',exact:true}).click();
    const saved=await savedResponse;expect(saved.status(),await saved.text()).toBe(200);
    const actual=(await forms.read(designer,next.sourceId)).document!;
    expect(actual.materials[0]).toMatchObject({materialId:next.materialId,name:current.name,specification:current.specification,supplier:'',auxiliaryCatalog:{id:current.id,version:current.version},available:false,requiredThisRound:false,color:'TEST 黑'});
    expect(actual.materials[0]).toMatchObject({unitPrice:'3.5',pricingUnit:'枚',auxiliaryCatalog:{referencePricing:{amount:'2.35',unit:'枚'}}});
    expect(actual.files).toEqual(next.saved.document!.files);
    expect((await forms.read(designer,original.sourceId)).document).toEqual(original.saved.document);
   }finally{await newTab.close();}
   const keeper=await createFromPage(tab.page,'TEST-保留目录-'+randomUUID());
   await tab.page.getByRole('textbox',{name:'搜索品名或规格',exact:true}).fill(old.name);
   await tab.page.getByRole('row').filter({hasText:current.name}).getByRole('button',{name:'版本历史',exact:true}).waitFor();
   expect(await tab.page.getByRole('button',{name:'合并重复项',exact:true}).count()).toBe(0);
   const mergeInput={expectedVersion:current.version,targetId:keeper.id,expectedTargetVersion:keeper.version,reason:'TEST 历史合并'};
   const deniedMerge=await tab.page.evaluate(async({id,body})=>(await fetch(`/api/master-data/auxiliaries/${id}/merge`,{method:'POST',headers:{'content-type':'application/json','idempotency-key':crypto.randomUUID()},body:JSON.stringify(body)})).status,{id:current.id,body:mergeInput});
   expect(deniedMerge).toBe(404);
   expect((await h.db.query('SELECT version,active,merged_into FROM auxiliary_catalog_items WHERE auxiliary_id=$1',[current.id])).rows[0]).toEqual({version:current.version,active:true,merged_into:null});
   // Arrange a pre-existing merge with its original command, never through a newly reachable HTTP action.
   const historicalService=new AuxiliaryCatalogService(h.db,{isRootUser:async()=>false}),mergeKey=randomUUID();
   const commercialCapabilities=(await h.db.query<{capability:string}>("SELECT capability FROM role_capabilities WHERE role_code='sample_designer'")).rows.map(row=>row.capability);
   const historical=await historicalService.merge({...designer,authorizationCapability:'auxiliary_catalog:write',authorizationCapabilities:commercialCapabilities},current.id,mergeInput,mergeKey);
   expect(historical).toMatchObject({id:current.id,version:current.version+1,active:false,mergedInto:keeper.id});
   const historicalReceipt=await tab.page.evaluate(async key=>{const r=await fetch(`/api/master-data/auxiliaries/receipt?action=merge&key=${key}`);if(!r.ok)throw Error('Legacy receipt failed '+r.status);return (await r.json()).receipt;},mergeKey);
   expect(historicalReceipt).toEqual(historical);
   expect((await forms.read(designer,original.sourceId)).document).toEqual(original.saved.document);
   await tab.page.getByRole('checkbox',{name:'显示停用及已合并记录',exact:true}).check();
   await tab.page.getByRole('row').filter({hasText:current.name}).getByRole('cell',{name:'已合并',exact:true}).waitFor();
   await tab.page.getByRole('checkbox',{name:'显示停用及已合并记录',exact:true}).uncheck();
   const keeperRow=tab.page.getByRole('row').filter({hasText:keeper.name});
   await keeperRow.getByRole('button',{name:'停用',exact:true}).click();
   const disable=tab.page.getByRole('dialog',{name:'停用',exact:true});
   await disable.getByRole('textbox',{name:'本次变更原因',exact:true}).fill('TEST 保留旧资料后停用');
   await disable.getByRole('button',{name:'保存共享目录',exact:true}).click();
   const confirmDisable=tab.page.getByRole('alertdialog',{name:'确认停用辅料',exact:true});
   await confirmDisable.getByRole('button',{name:'继续编辑',exact:true}).click();
   expect((await h.db.query('SELECT active FROM auxiliary_catalog_items WHERE auxiliary_id=$1',[keeper.id])).rows[0].active).toBe(true);
   const disabled=tab.page.waitForResponse(response=>new URL(response.url()).pathname===`/api/master-data/auxiliaries/${keeper.id}/disable`&&response.request().method()==='POST');
   await disable.getByRole('button',{name:'保存共享目录',exact:true}).click();
   await confirmDisable.getByRole('button',{name:'确认停用',exact:true}).click();
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
     const response=await fetch('/api/master-data/auxiliaries',{method:'POST',headers:{'content-type':'application/json','idempotency-key':crypto.randomUUID()},body:JSON.stringify({name:'TEST-PAGE-'+crypto.randomUUID(),specification:'TEST',auxiliaryKind:'普通辅料'})});
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
   await page.getByRole('button',{name:'新增辅料',exact:true}).click();
   const editor=page.getByRole('dialog',{name:'新增辅料',exact:true}),name='TEST-目录回执-'+randomUUID();
   await editor.getByRole('textbox',{name:'辅料品名',exact:true}).fill(name);
   await editor.getByRole('button',{name:'取消本次编辑',exact:true}).click();
   const confirmation=page.getByRole('alertdialog').filter({hasText:'目录资料尚未保存'});
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
