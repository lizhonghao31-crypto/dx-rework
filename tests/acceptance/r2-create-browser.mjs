import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import sharp from 'sharp';
export async function createBrowser({page,context,origin,database,root,checks,out,requests}){
 await context.clearCookies();await context.addCookies([{name:'dx_rework_session',value:root.actorId,url:origin}]);
 // Local UI fixture for category-confirmation behavior; price authorization is covered by original service tests.
 const categories=[{priceId:randomUUID(),name:'TEST品类甲',unit:'件'},{priceId:randomUUID(),name:'TEST品类乙',unit:'件'}];
 await context.route(`${origin}/api/pattern-room/category-options`,route=>route.fulfill({json:categories}));
 await context.route(`${origin}/api/pattern-room/category-options/*/quote`,route=>{const item=categories.find(c=>route.request().url().includes(c.priceId));return route.fulfill({json:{...item,amount:'10.000',version:1}});});
 await page.goto(`${origin}/ui/digital-production?workspace=designer`);
 const create=page.getByRole('button',{name:'新建开发订单',exact:true});await create.waitFor();assert.equal(await page.getByLabel('选中开发档案').count(),0);await create.click();
 const style=`TEST-R2-PR06-${randomUUID()}`;await page.getByLabel('设计款号',{exact:true}).fill(style);
 await page.getByRole('button',{name:'有确定客户订单',exact:true}).click();await page.getByLabel('PO 1 颜色',{exact:true}).fill('TEST蓝');await page.getByRole('button',{name:'添加款色 / PO',exact:true}).click();await page.getByRole('button',{name:'添加款色 / PO',exact:true}).click();
 await page.getByRole('button',{name:'无确定客户订单',exact:true}).click();assert.equal(await page.getByLabel('PO 1 颜色',{exact:true}).count(),0);
 await page.getByRole('button',{name:'有确定客户订单',exact:true}).click();assert.equal(await page.getByLabel('PO 1 颜色',{exact:true}).inputValue(),'TEST蓝');assert.equal(await page.getByLabel('PO 3 颜色',{exact:true}).count(),1);
 const calendar=await (await page.request.get(`${origin}/api/digital-production/options`)).json();assert.equal(await page.getByLabel('客户下单日期',{exact:true}).getAttribute('max'),calendar.serverToday);
 await page.getByRole('button',{name:'无确定客户订单',exact:true}).click();
 const image=await sharp({create:{width:70,height:80,channels:3,background:'#3468aa'}}).png().toBuffer();
 for(const label of ['主款图','局部图','菲林图','工艺开发板']){await page.getByRole('button',{name:new RegExp(`^${label}（`)}).click();const plus=page.getByRole('button',{name:'添加开发附件',exact:true});assert.equal(await page.locator('.development-file-tabs').getByRole('button',{name:'添加开发附件'}).count(),1);const choose=page.waitForEvent('filechooser');await plus.click();await (await choose).setFiles({name:`${label}.png`,mimeType:'image/png',buffer:image});await page.waitForFunction(()=>!document.querySelector('#development-upload')?.disabled);}
 await page.getByLabel('制作说明（选填）',{exact:true}).fill('TEST PR06 同一份草稿');
 const template=page.getByRole('combobox',{name:'尺寸模板',exact:true});await template.selectOption('裤子');await page.getByRole('dialog').getByRole('button',{name:'取消',exact:true}).click();assert.equal(await template.inputValue(),'上衣');
 const category=page.getByRole('combobox',{name:'打板品类',exact:true});await category.fill('TEST品类甲');await page.getByRole('option',{name:'TEST品类甲',exact:true}).click();await page.getByText('执行单价：10.000 元/件',{exact:true}).waitFor();
 await category.fill('TEST品类乙');await page.getByRole('option',{name:'TEST品类乙',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'取消',exact:true}).click();assert.equal(await category.inputValue(),'TEST品类甲');assert.equal(await template.inputValue(),'上衣');
 checks.push('PR06 template/category cancellation keeps original values; category catalog/quote is a local UI fixture, no wage write');
 const before=requests.length;await page.getByLabel('制作说明（选填）',{exact:true}).dispatchEvent('keydown',{key:'Enter',isComposing:true});assert.equal(requests.slice(before).filter(r=>r.method==='POST'&&r.url.endsWith('/publish')).length,0);
 await page.getByRole('button',{name:'保存开发资料草稿',exact:true}).click();await page.getByText('开发资料与订购草稿已保存，重开可继续；尚未发布或创建客户订单。',{exact:true}).waitFor();
 const rows=(await database.query('SELECT source_id FROM digital_production_sources WHERE design_style_no=$1',[style])).rows;assert.equal(rows.length,1);const id=rows[0].source_id;
 assert.equal((await database.query('SELECT count(*)::int n FROM digital_production_orders WHERE source_id=$1',[id])).rows[0].n,0);
 await page.goto(`${origin}/ui/digital-production?development=${id}`);await page.getByLabel('确定客户订单',{exact:true}).waitFor();assert.equal(await page.getByLabel('设计款号',{exact:true}).inputValue(),style);assert.equal(await page.getByLabel('制作说明（选填）',{exact:true}).inputValue(),'TEST PR06 同一份草稿');
 await page.getByRole('button',{name:'有确定客户订单',exact:true}).click();assert.equal(await page.getByLabel('PO 1 颜色',{exact:true}).inputValue(),'TEST蓝');
 await page.getByRole('button',{name:'无确定客户订单',exact:true}).click();await page.getByRole('button',{name:'保存开发资料草稿',exact:true}).click();await page.getByText('开发资料与订购草稿已保存，重开可继续；尚未发布或创建客户订单。',{exact:true}).waitFor();
 const doc=(await database.query('SELECT document FROM digital_development_documents WHERE source_id=$1',[id])).rows[0].document;assert.deepEqual(doc.files.map(f=>f.kind),['款图','局部图','菲林','工艺开发板']);assert.equal(doc.customerOrderDraft.order.lines.length,3);
 await page.screenshot({path:`${out}/pr06-resumed-draft.png`});checks.push('PR06 single create/resume editor: type toggles retain 3 POs, server date max, four header upload categories, draft persists once without order, IME does not publish');
}
