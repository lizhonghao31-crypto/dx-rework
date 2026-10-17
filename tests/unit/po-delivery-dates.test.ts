import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe,expect,it } from "vitest";
import { earliestFactoryPo,poDateSummary,poDeliveryRisks,PoDeliveryDateSchema,type PoDeliveryDate } from "@dx-rework/contracts";
import { PoDateDetails,PoDateSummary } from "../../apps/web/src/po-delivery-dates.js";
const line=(index:number,patch:Partial<PoDeliveryDate>={}):PoDeliveryDate=>PoDeliveryDateSchema.parse({lineId:`00000000-0000-4000-8000-${String(index).padStart(12,'0')}`,position:index,poNumber:`TEST-PO-${index}`,color:'黑',customerWarehouseArrivalDate:'2026-10-20',factoryDeliveryDate:'2026-10-10',sampleTargetDate:'2026-10-10',...patch});
describe("current PO promises without manufactured production or SLA",()=>{
 it("keeps a complete single day compact, distinguishes ranges and states incomplete registration",()=>{
  expect(poDateSummary(['2026-11-01','2026-11-01'])).toBe('2026-11-01');
  expect(poDateSummary(['2026-11-09','2026-11-01',null])).toBe('2026-11-01 ～ 2026-11-09（多交期） · 有 PO 日期待补（1/3）');
  expect(poDateSummary([null,null])).toBe('有 PO 日期待补（2/2）');
  expect(poDateSummary([])).toBe('未登记');
 });
 it("uses the earliest PO promise without any per-PO completion requirement",()=>{
  const lines=[line(1,{factoryDeliveryDate:'2026-10-01'}),line(2,{factoryDeliveryDate:'2026-10-08'}),line(3,{factoryDeliveryDate:null})];
  expect(earliestFactoryPo(lines)).toMatchObject({date:'2026-10-01',lines:[{poNumber:'TEST-PO-1'}]});
  expect(earliestFactoryPo([line(3,{factoryDeliveryDate:null})])).toBeNull();
  expect(poDeliveryRisks(lines,'2026-10-02',{finished:false,factoryFinished:false,sampleFinished:false}).filter(risk=>risk.kind==='factory').map(risk=>risk.poNumber)).toEqual(['TEST-PO-1']);
  expect(poDeliveryRisks(lines,'2026-10-02',{finished:false,factoryFinished:true,sampleFinished:false}).filter(risk=>risk.kind==='factory')).toEqual([]);
  expect(PoDeliveryDateSchema.safeParse({...lines[0],completedQuantity:10}).success).toBe(false);
 });
 it("never marks missing dates late, uses natural business dates, and suppresses completed work",()=>{
  const unknown=line(1,{factoryDeliveryDate:null,customerWarehouseArrivalDate:null,sampleTargetDate:null});
  const options={finished:false,factoryFinished:false,sampleFinished:false};
  expect(poDeliveryRisks([unknown],'2026-12-31',options)).toEqual([]);
  const risk=poDeliveryRisks([line(2)],'2026-10-10',options);
  expect(risk.map(row=>[row.kind,row.risk])).toEqual([['factory','due_soon'],['sample','due_soon']]);
  expect(poDeliveryRisks([line(2)],'2026-10-11',options).every(row=>row.risk==='overdue')).toBe(true);
  expect(poDeliveryRisks([line(2)],'2026-12-31',{finished:true,factoryFinished:false,sampleFinished:false})).toEqual([]);
  expect(poDeliveryRisks([line(2)],'2026-12-31',{finished:false,factoryFinished:true,sampleFinished:true}).map(row=>row.kind)).toEqual(['customer']);
 });
 it("renders full date names, per-PO targets, missing dates and no added per-PO production fields",()=>{
  const lines=[line(1),line(2,{customerWarehouseArrivalDate:'2026-10-23',factoryDeliveryDate:'2026-10-13',sampleTargetDate:'2026-10-13'}),line(3,{customerWarehouseArrivalDate:null,factoryDeliveryDate:null,sampleTargetDate:null})];
  const html=renderToStaticMarkup(createElement(PoDateDetails,{lines}));
  for(const value of ['客户仓到货日','加工厂交货日','船样目标日','TEST-PO-1','TEST-PO-2','TEST-PO-3','客户日期待补'])expect(html).toContain(value);
  expect(html).not.toContain('%');expect(html).not.toContain('实绩');expect(html).not.toContain('完成率');
  const summary=renderToStaticMarkup(createElement(PoDateSummary,{lines,legacy:'1999-01-01'}));
  expect(summary).toContain('多交期');expect(summary).toContain('有 PO 日期待补');expect(summary).not.toContain('1999-01-01');
  expect(renderToStaticMarkup(createElement(PoDateSummary,{lines:undefined,legacy:'2026-10-31'}))).toContain('加工厂交货日：2026-10-31');
 });
});
