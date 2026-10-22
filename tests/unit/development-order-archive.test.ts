import {randomUUID} from 'node:crypto';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe,expect,it} from 'vitest';
import type {DevelopmentWorkspaceItem} from '@dx-rework/contracts/digital-development-workspace';
import type {DigitalOrder} from '@dx-rework/contracts/digital-production';
import {DevelopmentOrderArchive} from '../../apps/web/src/development-order-archive.js';
const id=randomUUID(),line=randomUUID();
const item={view:'ordered',canConfirm:false,journey:{id,sourceId:id,orderId:id,designStyleNo:'TEST档案',styleName:null,customer:'PD',category:'男装',designer:'TEST设计师',developmentType:'头版',createdAt:'2026-10-15T00:00:00Z',selectedRound:2,adoptedRound:1,lines:[{id:line,formalStyleNo:'PO-TEST',po:'PO-TEST',temporaryStyleNo:null,color:'蓝',orderedQuantity:17}],poDeliveryDates:[{lineId:line,poNumber:'PO-TEST',color:'蓝',customerWarehouseArrivalDate:'2026-12-10',factoryDeliveryDate:'2026-12-01',sampleTargetDate:'2026-11-30'}]}} as unknown as DevelopmentWorkspaceItem;
const order={lines:[{lineId:line,sizes:[{size:'M',quantity:10},{size:'L',quantity:7}]}]} as DigitalOrder;
const render=(value=item,extra:Partial<Parameters<typeof DevelopmentOrderArchive>[0]>={})=>renderToStaticMarkup(createElement(DevelopmentOrderArchive,{item:value,sheet:undefined,order,sheetError:undefined,orderError:undefined,sourceUrl:'/ui/digital-production?workspace=designer&development=TEST&round=2',...extra}));
describe('combined read-only development archive',()=>{
 it('shows per-size quantities and independent authoritative dates directly, without duplicate tabs or date inputs',()=>{
  const html=render();for(const text of ['订单档案','每码数量','M：10','L：7','出货日期','加工厂交货日','船样目标日','2026-12-10','2026-12-01','2026-11-30','资料版本与采用轮次','大货采用第 1 轮'])expect(html).toContain(text);
  expect(html).not.toContain('客户仓到货日');expect(html).toContain('本单资料');expect(html).not.toContain('<details');expect(html).not.toContain('<input');expect(html).not.toContain('<select');expect(html).not.toContain('查看完整订购信息');expect(html).toContain('round=2');
 });
 it('keeps three PO quantities and independent dates visible without tabs',()=>{
  const value=structuredClone(item);value.journey.lines=Array.from({length:3},(_,i)=>({...value.journey.lines[0]!,id:line+i,po:'PO-'+i,orderedQuantity:i+1}));value.journey.poDeliveryDates=value.journey.lines.map((l,i)=>({...value.journey.poDeliveryDates![0]!,lineId:l.id,customerWarehouseArrivalDate:'2026-12-'+(10+i)}));const html=render(value);for(const day of ['2026-12-10','2026-12-11','2026-12-12'])expect(html).toContain(day);expect(html.match(/<tbody>[\s\S]*<\/tbody>/)?.[0].match(/<tr>/g)).toHaveLength(3);expect(html).not.toContain('role="tab"');
 });
 it('keeps no-order archives and unknown dates explicit rather than inventing targets',()=>{
  const missing=structuredClone(item);missing.journey.poDeliveryDates![0]!.sampleTargetDate=null;expect(render(missing)).toContain('未登记');
  missing.journey.orderId=null;missing.journey.lines=[];expect(render(missing)).toContain('此开发档案尚无确定客户订单');expect(render(missing)).not.toContain('逐PO数量与日期');
 });
 it('keeps read failures visible and the archive read-only even when its source is eligible for confirmation',()=>{
  const html=render(item,{order:undefined,orderError:'无权访问当前资料'});expect(html).toContain('订购尺码资料读取失败');expect(html).toContain('无权访问当前资料');expect(html).not.toContain('客户确定订单');
  const eligible=structuredClone(item);eligible.canConfirm=true;eligible.journey.orderId=null;
  expect(render(eligible)).not.toContain('<button');expect(render(eligible)).toContain('此开发档案尚无确定客户订单');
 });
});
