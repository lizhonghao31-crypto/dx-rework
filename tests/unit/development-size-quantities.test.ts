import {CreatePatternOrderSchema,UpdatePatternMaterialsSchema,UpdateLinkedPatternMaterialsSchema} from "@dx-rework/contracts/pattern-orders";
import {describe,it,expect} from "vitest";
import {randomUUID} from "node:crypto";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {DevelopmentPrint} from "../../apps/web/src/digital-development-print.js";
import {DevelopmentDocumentSchema,developmentPublishErrors,developmentMakingSizes} from "@dx-rework/contracts/digital-development";
import {developmentAmendmentErrors} from "@dx-rework/contracts/digital-development-amendments";
import {initialDevelopmentDocument,removeDevelopmentSize,moveDevelopmentSize,developmentSizeQuantityInputs,developmentOrderInput} from "../../apps/web/src/digital-development-editing.js";
import {developmentIssues} from "../../apps/web/src/digital-development-validation.js";
import {developmentAutomaticRoundDocument,developmentDraftForSave,developmentRevisionForSave,legacyAmendmentPublicationOptions} from "../../apps/api/src/production-platform/development-document-format.js";
const document=()=>({...initialDevelopmentDocument(),quantity:3,sizes:["M","L","XL"],sizeQuantities:[2,1,0],measurements:[{name:"胸围",values:["90","94","98"]}],orderDate:"2026-10-20",files:[{attachmentId:randomUUID(),kind:"款图" as const}],materials:[]});
describe("P03 per-size making quantities and frozen development date",()=>{
 it("uses one size matrix for making and keeps PO order quantities independent",()=>{
  const value=document();expect(DevelopmentDocumentSchema.safeParse(value).success).toBe(true);expect(developmentPublishErrors(value)).toEqual([]);expect(developmentMakingSizes(value)).toBe("M 2件 / L 1件");
  const order=developmentOrderInput({customerCode:"TEST",designStyleNo:"TEST",temporaryStyleNo:null,productGroup:"男装",primaryMerchandiserId:null,orderDate:"2026-10-20",contractDeliveryDate:null,lines:[{formalPoNo:null,poNumber:null,formalStyleNo:null,temporaryStyleNo:null,color:"黑",colorForeign:null,deliveryDate:null,customerWarehouseArrivalDate:null,sizes:[{size:"M",quantity:"400"},{size:"L",quantity:"200"}]}]});expect(order.lines[0]!.sizes.reduce((n,item)=>n+item.quantity,0)).toBe(600);expect(value.quantity).toBe(3);
 });
 it("allows blank draft values but refuses blank, all-zero, mismatch, downgrade and invalid numeric publication",()=>{
  const value=document();expect(DevelopmentDocumentSchema.safeParse({...value,sizeQuantities:[null,null,null]}).success).toBe(true);
  for(const sizeQuantities of [[null,1,0],[0,0,0],[1,1,0]])expect(developmentPublishErrors({...value,sizeQuantities}).length).toBeGreaterThan(0);
  for(const sizeQuantities of [[-1,4,0],[1.5,1.5,0],[100001,0,0],[2,1]])expect(DevelopmentDocumentSchema.safeParse({...value,sizeQuantities}).success).toBe(false);
  const {documentFormatVersion:_version,sizeQuantities:_counts,...legacy}=value;void _version;void _counts;expect(developmentPublishErrors(legacy).join()).toContain("逐码");expect(DevelopmentDocumentSchema.safeParse({...value,documentFormatVersion:1}).success).toBe(false);
  for(const input of ["-1","1.5","2件","100001"]){const issues=developmentIssues({...value,sizeQuantities:[null,1,0]},"3",["row"],false,null,[input,"1","0"]);expect(issues[0]?.id).toBe("development-size-quantity-0");}
 });
 it("moves/removes the same column atomically, retaining zero and technical fractions",()=>{
  const value=document();value.measurements[0]!.values[0]="2 1/2";
  const moved=moveDevelopmentSize(value,0,2);expect(moved.sizes).toEqual(["L","XL","M"]);expect(moved.sizeQuantities).toEqual([1,0,2]);expect(moved.measurements[0]!.values).toEqual(["94","98","2 1/2"]);
  const removed=removeDevelopmentSize(moved,1);expect(removed.sizes).toEqual(["L","M"]);expect(removed.sizeQuantities).toEqual([1,2]);expect(developmentSizeQuantityInputs(removed)).toEqual(["1","2"]);
 });
 it("obtains first date from server createdAt in Beijing and never trusts a client date or later clock",()=>{
  const value=document(),saved=developmentDraftForSave({...value,orderDate:null},undefined,"2026-10-19T16:01:00Z");expect(saved.orderDate).toBe("2026-10-20");
  expect(developmentDraftForSave(saved,saved,"2026-10-22T23:00:00Z").orderDate).toBe("2026-10-20");
  expect(developmentDraftForSave({...saved,orderDate:"2026-09-30"},{...saved,orderDate:"2026-09-30"},"2026-10-22T23:00:00Z").orderDate).toBe("2026-09-30");
  expect(()=>developmentDraftForSave({...value,orderDate:"2026-10-21"},undefined,"2026-10-20T00:00:00Z")).toThrow("固定为");
  expect(()=>developmentDraftForSave({...saved,documentFormatVersion:undefined},saved,"2026-10-20T00:00:00Z")).toThrow("不能移除");
 });
 it("upgrades an old draft explicitly but permits legacy correction only with unchanged server-frozen making facts",()=>{
  const {documentFormatVersion:_version,sizeQuantities:_counts,...legacy}=document();void _version;void _counts;legacy.sampleSize="旧码 42";legacy.orderDate=null;
  expect(developmentMakingSizes(legacy)).toBe("旧码 42");expect(developmentDraftForSave(legacy,legacy,"2026-09-30T00:00:00Z")).toMatchObject({documentFormatVersion:2,sizeQuantities:[null,null,null],orderDate:"2026-09-30"});
  const corrected={...legacy,instructions:"资料澄清"},options=legacyAmendmentPublicationOptions(legacy,corrected);expect(developmentPublishErrors(corrected,options)).toEqual([]);expect(legacy.orderDate).toBeNull();
  expect(developmentAmendmentErrors(legacy,{...corrected,quantity:4}).length).toBeGreaterThan(0);expect(legacyAmendmentPublicationOptions(document(),legacy).allowLegacySizeQuantities).toBe(false);
  expect(developmentPublishErrors(developmentRevisionForSave(legacy,legacy),{allowMissingOrderDate:true}).join()).toContain("制作数量");expect(()=>developmentRevisionForSave({...document(),orderDate:"2026-10-21"},document())).toThrow("首次");
 });
 it("requires explicit automatic-round upgrades with a matching basis and never mutates frozen making facts",()=>{
  const legacy=document();delete legacy.documentFormatVersion;delete legacy.sizeQuantities;legacy.orderDate=null;
  const frozen=structuredClone(legacy);expect(()=>developmentAutomaticRoundDocument(legacy,4,undefined)).toThrow('历史资料缺少');
  for(const quantities of [[1,1,0],[0,0,0],[-1,4,0],[1.5,1.5,0],[3]])expect(()=>developmentAutomaticRoundDocument(legacy,4,{expectedDocumentVersion:4,quantities})).toThrow();
  expect(()=>developmentAutomaticRoundDocument(legacy,4,{expectedDocumentVersion:3,quantities:[2,1,0]})).toThrow('依据已更新');
  const upgraded=developmentAutomaticRoundDocument(legacy,4,{expectedDocumentVersion:4,quantities:[0,3,0]});expect(upgraded).toMatchObject({documentFormatVersion:2,sizeQuantities:[0,3,0],orderDate:null});expect(legacy).toEqual(frozen);
  expect(developmentPublishErrors(upgraded,{allowMissingOrderDate:true})).toEqual([]);
  expect(()=>developmentAutomaticRoundDocument(document(),4,{expectedDocumentVersion:4,quantities:[0,3,0]})).toThrow('已有有效');
 });
 it("keeps standalone free text at 200 while linked update transport preserves a generated summary",()=>{
  const input={styleNo:'TEST',requiredDate:null,customer:null,sizeColor:'码'.repeat(250),referenceStyleNo:null,variant:null,note:'TEST',attachmentIds:[randomUUID()],reason:'TEST更新无关字段',version:1,roundId:randomUUID()};
  expect(UpdatePatternMaterialsSchema.safeParse(input).success).toBe(false);expect(UpdateLinkedPatternMaterialsSchema.safeParse(input).success).toBe(true);
  const {version:_v,roundId:_r,reason:_why,...materials}=input;void _v;void _r;void _why;
  expect(CreatePatternOrderSchema.safeParse({...materials,categoryId:randomUUID(),quantity:1,priceVersion:1}).success).toBe(false);
 });
 it("prints the same positive making summary and zero columns without substituting PO counts",()=>{
  const value=document(),sheet={sourceId:randomUUID(),designStyleNo:"TEST",temporaryStyleNo:null,customerCode:null,developmentType:"头版",designerName:"TEST设计师",version:2,status:"published" as const,document:value,publishedAt:null,taskId:null,canEdit:false,materialEvents:[]};
  const html=renderToStaticMarkup(createElement(DevelopmentPrint,{sheet,document:value,imageUrl:()=>"/TEST.png"}));
  expect(html).toContain("M 2件 / L 1件");expect(html).toContain("制作数量（件）");expect(html).toContain("<td>0</td>");expect(html).not.toContain("本轮打样尺码");
 });
});
