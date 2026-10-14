import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {describe,expect,it} from "vitest";
import {InitialCustomerOrderDraftSchema} from "@dx-rework/contracts/digital-production";
import type {DevelopmentSheet} from "@dx-rework/contracts/digital-development";
import type {OrderJourney} from "@dx-rework/contracts/digital-production-journey";
import {DevelopmentCreateForm} from "../../apps/web/src/digital-development-create-form.js";
import {initialDevelopmentDocument} from "../../apps/web/src/digital-development-editing.js";
const id="11111111-1111-4111-8111-111111111111";
const source={id,sourceId:id,designStyleNo:"TEST-RESUME",temporaryStyleNo:null,customer:"PD",designer:"TEST设计师",selectedRound:1} as OrderJourney;
const order=InitialCustomerOrderDraftSchema.parse({customerCode:"PD",productGroup:"男装",designStyleNo:"TEST-RESUME",orderDate:"2026-10-15",contractDeliveryDate:null,lines:[{color:"TEST蓝",deliveryDate:null,customerWarehouseArrivalDate:"2099-12-30",sizes:[{size:"M",quantity:"19"}]}]});
const sheet:DevelopmentSheet={sourceId:id,productionOrderId:null,designStyleNo:"TEST-RESUME",temporaryStyleNo:null,customerCode:"PD",developmentType:"头版",designerName:"TEST设计师",version:2,status:"published",publishedAt:"2026-10-15T00:00:00Z",taskId:id,canEdit:true,document:{...initialDevelopmentDocument(),customerOrderDraft:{withOrder:true,order}},materialEvents:[]};
describe("published customer confirmation resumes its saved PO",()=>{
 it("restores saved colors, quantities and dates and locks the published customer facts",()=>{
  const html=renderToStaticMarkup(createElement(DevelopmentCreateForm,{intent:"confirm_order",source,existingDraft:sheet,customers:[],onCancel:()=>undefined,onCreated:()=>undefined}));
  for(const value of ['value="TEST蓝"','value="19"','value="2099-12-30"','订购草稿已随开发资料发布'])expect(html).toContain(value);
  expect(html).toContain('<fieldset disabled="" class="development-order-fields">');
 });
 it("leaves later confirmation editable when the published development had no customer order",()=>{
  const html=renderToStaticMarkup(createElement(DevelopmentCreateForm,{intent:"confirm_order",source,existingDraft:{...sheet,document:initialDevelopmentDocument()},customers:[],onCancel:()=>undefined,onCreated:()=>undefined}));
  expect(html).not.toContain('<fieldset disabled="" class="development-order-fields">');expect(html).not.toContain('value="19"');
 });
});
