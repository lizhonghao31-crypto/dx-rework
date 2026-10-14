import {describe,it,expect} from "vitest";
import {minimumInitialCustomerDate,initialCustomerDateErrors,initialCustomerOrderInput,InitialCustomerOrderDraftSchema} from "@dx-rework/contracts/digital-production";
import {DevelopmentDocumentSchema} from "@dx-rework/contracts/digital-development";
import {initialDevelopmentDocument} from "../../apps/web/src/digital-development-editing.js";
describe("first confirmed customer-order calendar",()=>{
 it.each([
  ["2026-04-30T16:00:00Z","2026-06-01"],
  ["2026-01-30T16:00:00Z","2026-02-28"],
  ["2024-01-30T16:00:00Z","2024-02-29"],
  ["2026-12-30T16:00:00Z","2027-01-31"],
  ["2026-05-27T16:00:00Z","2026-06-28"],
 ])("uses Shanghai day and natural-month clamping: %s",(now,minimum)=>expect(minimumInitialCustomerDate(new Date(now))).toBe(minimum));
 it("locates each invalid PO and accepts the boundary; does not validate factory or sample dates",()=>{
  expect(initialCustomerDateErrors([{customerWarehouseArrivalDate:"2026-06-01"},{deliveryDate:"2026-05-28"},{customerWarehouseArrivalDate:null}],"2026-06-01")).toEqual([
   "PO 2 客户侧交期须填写 2026-06-01 或之后的日期（首次确定订单至少一个自然月）",
   "PO 3 客户侧交期须填写 2026-06-01 或之后的日期（首次确定订单至少一个自然月）",
  ]);
 });
 it("persists incomplete PO text with the same development document without treating it as an order",()=>{
  const order=InitialCustomerOrderDraftSchema.parse({customerCode:"",productGroup:"男装",designStyleNo:"TEST",orderDate:"",contractDeliveryDate:null,lines:[{color:"",deliveryDate:null,sizes:[{size:"M",quantity:"1."}]}]});
  const document={...initialDevelopmentDocument(),customerOrderDraft:{withOrder:true,order}};
  expect(DevelopmentDocumentSchema.parse(JSON.parse(JSON.stringify(document))).customerOrderDraft).toEqual(document.customerOrderDraft);
  expect(()=>initialCustomerOrderInput(order)).toThrow("PO 1 M");
 });
});
