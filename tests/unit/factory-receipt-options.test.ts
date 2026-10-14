import { describe, expect, it } from "vitest";
import type { ProductionReceivingSummary } from "@dx-rework/contracts";
import { loadFactoryReceiptOptions } from "../../apps/web/src/factory-receipt-options.js";
const items = Array.from({length:31}, (_, index) => ({ productionOrderId: `order-${index}`, factoryDecisionId: null, supplierName: `加工厂${index}` } as ProductionReceivingSummary));
describe("complete scoped factory receipt candidates", () => {
 it("collects beyond the first fifteen choices without broadening the supplied scope", async () => {
  const pages:number[]=[];
  const result=await loadFactoryReceiptOptions(async page=>{pages.push(page);return {items:items.slice((page-1)*15,page*15),page,totalCount:31};},new AbortController().signal);
  expect(pages).toEqual([1,2,3]);expect(result).toEqual(items);expect(result[30]?.supplierName).toBe("加工厂30");
 });
 it("never presents a partial list after a later page is denied",async()=>{
  await expect(loadFactoryReceiptOptions(async page=>{if(page===2)throw new Error("FORBIDDEN");return {items:items.slice(0,15),page,totalCount:31};},new AbortController().signal)).rejects.toThrow("FORBIDDEN");
 });
 it("rejects moving or duplicated pagination rather than silently omitting choices",async()=>{
  await expect(loadFactoryReceiptOptions(async page=>({items:items.slice(0,15),page,totalCount:30}),new AbortController().signal)).rejects.toThrow("候选已变化");
  await expect(loadFactoryReceiptOptions(async page=>({items:items.slice((page-1)*15,page*15),page,totalCount:page===1?31:30}),new AbortController().signal)).rejects.toThrow("候选已变化");
 });
 it("stops after the scope is unmounted",async()=>{
  const controller=new AbortController();const pages:number[]=[];
  await expect(loadFactoryReceiptOptions(async page=>{pages.push(page);controller.abort();return {items:items.slice(0,15),page,totalCount:31};},controller.signal)).rejects.toThrow();expect(pages).toEqual([1]);
 });
});
