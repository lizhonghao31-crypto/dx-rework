import {describe,expect,it} from "vitest";
import {randomUUID} from "node:crypto";
import {DEVELOPMENT_MEASUREMENTS,DevelopmentDocumentSchema,developmentPublishErrors,withoutDevelopmentAlternateSizeDraft} from "@dx-rework/contracts/digital-development";
import {changeDevelopmentCreationGarment,hasCustomizedDevelopmentSizes,initialDevelopmentDocument,initializeGuidedDevelopmentSizes,initialGuidedDevelopmentDocument} from "../../apps/web/src/digital-development-editing.js";
import {developmentDraftForSave,developmentRevisionForSave} from "../../apps/api/src/production-platform/development-document-format.js";

describe("guided creation garment and optional size stage",()=>{
  it.each(["上衣","裤子"] as const)("uses the original %s template only when opening the size editor",template=>{
    const draft=initialGuidedDevelopmentDocument({template,rush:false});
    expect(draft).toMatchObject({template,templateConfirmed:true,rush:false,measurements:[],sizes:[]});
    expect(draft.sizeTableInitialized).toBeUndefined();
    const initialized=initializeGuidedDevelopmentSizes(draft);
    expect(initialized.measurements.map(row=>row.name)).toEqual(DEVELOPMENT_MEASUREMENTS[template]);
    expect(initialized.sizes).toEqual([]);
    expect(hasCustomizedDevelopmentSizes(initialized,[])).toBe(false);
    const intentionallyEmpty={...initialized,measurements:[]};
    expect(initializeGuidedDevelopmentSizes(intentionallyEmpty)).toBe(intentionallyEmpty);
    expect(hasCustomizedDevelopmentSizes(intentionallyEmpty,[])).toBe(true);
  });
  it("preserves independently edited matrices, raw counts and intentionally removed rows in the original draft",()=>{
    const a={...initializeGuidedDevelopmentSizes(initialGuidedDevelopmentDocument({template:"上衣",rush:true})),unit:"inch" as const,
      sizes:["S","MT"],measurements:[{name:"自定义袖口",values:["7⅓",""]}],sizeQuantities:[2,null]};
    const b=changeDevelopmentCreationGarment(a,"裤子",["2",""]);
    expect(b.document).toMatchObject({template:"裤子",rush:true,measurements:[],sizes:[],alternateSizeDraft:{template:"上衣"}});
    const second={...initializeGuidedDevelopmentSizes(b.document),measurements:[],sizes:["32"],sizeQuantities:[null]};
    const saved=DevelopmentDocumentSchema.parse(JSON.parse(JSON.stringify(second)));
    const reopened=changeDevelopmentCreationGarment(saved,"上衣",[""]);
    expect(reopened.document).toMatchObject({template:"上衣",unit:"inch",sizes:["S","MT"],measurements:a.measurements,sizeQuantities:[2,null]});
    expect(reopened.rawQuantities).toEqual(["2",""]);
    const returned=changeDevelopmentCreationGarment(reopened.document,"裤子",reopened.rawQuantities);
    expect(initializeGuidedDevelopmentSizes(returned.document)).toMatchObject({template:"裤子",measurements:[],sizes:["32"],sizeQuantities:[null]});
    expect(withoutDevelopmentAlternateSizeDraft(returned.document)).not.toHaveProperty("alternateSizeDraft");
    expect(returned.document.alternateSizeDraft?.sizes).toEqual(["S","MT"]);
  });
  it("requires explicit classification of a legacy draft and never resets its original matrix",()=>{
    const legacy={...initialDevelopmentDocument(),unit:"inch" as const,sampleSize:"原历史样板尺码",measurements:[{name:"原已自定义项目",values:["10"]}],
      sizes:["自定义"],sizeQuantities:[null]};
    expect(legacy.templateConfirmed).toBeUndefined();
    expect(initializeGuidedDevelopmentSizes(legacy)).toBe(legacy);
    expect(hasCustomizedDevelopmentSizes(legacy,[""])).toBe(true);
    const chosen=changeDevelopmentCreationGarment(legacy,"裤子",[""]);
    expect(chosen.document).toMatchObject({template:"裤子",templateConfirmed:true,sizeTableInitialized:true,unit:"inch",
      sizes:legacy.sizes,measurements:legacy.measurements,sampleSize:legacy.sampleSize});
    expect(legacy.template).toBe("上衣");
  });
  it("permits empty or partial measurements on publication without relaxing making-count validation",()=>{
    const ready={...initialGuidedDevelopmentDocument({template:"裤子",rush:false}),quantity:2,orderDate:"2026-11-25",
      workbenchSheet:{version:1 as const,brand:"",styleName:"",boardType:"复版" as const,gender:"男装" as const,processingSelected:true,referenceNote:"",sewingRows:[]}};
    expect(developmentPublishErrors(ready)).toEqual([]);
    const partial={...ready,sizes:["M",""],sizeQuantities:[null,null],measurements:[{name:"腰围",values:["12.5",""]}]};
    expect(developmentPublishErrors(partial)).toEqual([]);
    expect(developmentPublishErrors({...partial,measurements:[{name:"腰围",values:["12.5","13"]}]})).toContain("请填写尺码列名称，或删除不用的列");
    expect(developmentPublishErrors({...partial,sizes:["M","L"],sizeQuantities:[1,0]})).toContain("各码制作数量合计1件，与本轮打板数量2件不一致，请核对尺寸表");
  });
  it("caps new style pictures only, preserving legacy originals and independent craft attachments",()=>{
    const draft=initialGuidedDevelopmentDocument({template:"上衣",rush:false});
    const style=Array.from({length:6},(_,index)=>({attachmentId:randomUUID(),kind:index===0?"款图" as const:"局部图" as const}));
    const craft={attachmentId:randomUUID(),kind:"工艺开发板" as const};
    const active={...draft,files:[...style.slice(0,5),craft]};
    const saved=developmentDraftForSave(active,undefined,"2026-11-25T00:00:00Z");
    expect(saved.files).toEqual(active.files);
    expect(()=>developmentDraftForSave({...active,files:[...style,craft]},saved,"2026-11-25T00:00:00Z")).toThrow(/款式图最多 5 张/);
    const legacy={...initialDevelopmentDocument(),orderDate:saved.orderDate,files:[...style,craft]};
    expect(developmentDraftForSave({...legacy,templateConfirmed:true},legacy,"2026-11-25T00:00:00Z").files).toEqual(legacy.files);
    expect(()=>developmentRevisionForSave({...legacy,templateConfirmed:true,files:[...style.slice(0,5),{...style[5]!,attachmentId:randomUUID()},craft]},legacy)).toThrow(/款式图最多 5 张/);
  });
});
