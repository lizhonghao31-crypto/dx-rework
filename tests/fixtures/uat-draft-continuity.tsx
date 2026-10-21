import {useRef,useState} from "react";
import {createRoot} from "react-dom/client";
import {ResumeDevelopmentCreateForm,initialDevelopmentOrder} from "../../apps/web/src/digital-development-create-form.js";
import {initialDevelopmentDocument} from "../../apps/web/src/digital-development-editing.js";
import {DocumentGuardContext} from "../../apps/web/src/use-digital-detail-navigation-guard.js";
import {SaveDevelopmentSchema,type DevelopmentSheet} from "@dx-rework/contracts/digital-development";
import "../../packages/ui/src/tokens.css";
import "../../packages/ui/src/components.css";
import "../../apps/web/src/styles.css";

const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const order=initialDevelopmentOrder([]);order.designStyleNo="TEST-DRAFT-CONTINUITY";order.customerCode="TEST";order.orderDate="2026-10-20";
order.lines=[1,2,3].map(n=>({formalPoNo:`TEST-PO-${n}`,customerWarehouseArrivalDate:"2099-12-31",poNumber:null,formalStyleNo:null,temporaryStyleNo:null,color:`TEST颜色${n}`,colorForeign:null,deliveryDate:null,sizes:[{size:"M",quantity:String(n*10)}]}));
const document={...initialDevelopmentDocument(),patternCategoryId:id(2),quantity:1,sizeQuantities:[1,0],sampleSize:"M",orderDate:"2026-10-20",returnDate:"2026-10-23",instructions:"TEST 初始说明",files:[{attachmentId:id(3),kind:"款图" as const}],customerOrderDraft:{withOrder:true,order}};
const state={saved:{sourceId:id(1),designStyleNo:order.designStyleNo,temporaryStyleNo:null,customerCode:"TEST",developmentType:"头版",designerName:"TEST设计师",version:1,status:"draft",document,publishedAt:null,taskId:null,canEdit:true,materialEvents:[]} as DevelopmentSheet,requests:[] as {path:string;method:string;body:unknown}[],failSave:false,failPublish:true,closed:0,created:0,unexpected:[] as string[]};
Object.assign(window,{uatDraftContinuity:state});
window.fetch=async(input,init)=>{
 const path=String(input),method=init?.method??"GET",body=init?.body?JSON.parse(String(init.body)):null;state.requests.push({path,method,body});
 if(path.endsWith("/options"))return Response.json({customers:[{code:"TEST",name:"TEST客户",productGroups:["男装"],defaultMerchandiserId:null,defaultMerchandiserName:null}],serverToday:"2026-10-20",minimumInitialCustomerDate:"2026-11-20"});
 if(path.endsWith("/category-options"))return Response.json([{priceId:id(2),name:"TEST上衣",unit:"件"}]);
 if(path.endsWith("/quote"))return Response.json({priceId:id(2),name:"TEST上衣",unit:"件",amount:"40.000",version:1});
 if(path.endsWith("/metadata"))return Response.json({attachmentId:id(3),filename:"TEST原款图.png",mimeType:"image/png",sizeBytes:100});
 if(path.endsWith(`/sources/${id(1)}/development`)){
  if(method==="PUT"){
   if(state.failSave){state.failSave=false;return Response.json({error:{message:"TEST 保存失败，填写保留"}},{status:503});}
   const parsed=SaveDevelopmentSchema.parse(body);if(parsed.expectedVersion!==state.saved.version)return Response.json({error:{message:"TEST 版本冲突"}},{status:409});
   state.saved={...state.saved,version:state.saved.version+1,document:structuredClone(parsed.document)};
  }
  return Response.json(state.saved);
 }
 if(path.endsWith("/development/publish")){
  if(state.failPublish)return Response.json({error:{message:"TEST 发布被拒绝；已保存草稿保留"}},{status:409});
  state.saved={...state.saved,status:"published",publishedAt:"2026-10-20T00:00:00Z"};return Response.json(state.saved);
 }
 if(path.endsWith("/confirm")){state.created++;return Response.json({productionOrderId:id(99)});}
 state.unexpected.push(`${method} ${path}`);throw new Error("Unexpected synthetic request");
};
function Fixture(){
 const guards=useRef(new Set<()=>Promise<boolean>>()),[open,setOpen]=useState(true),[generation,setGeneration]=useState(0);
 return <DocumentGuardContext.Provider value={guards.current}><button onClick={async()=>{for(const guard of guards.current)if(!await guard())return;setOpen(false);}}>TEST 切换资料目录</button>{open?<ResumeDevelopmentCreateForm key={generation} sheet={structuredClone(state.saved)} onClose={()=>{state.closed++;setOpen(false);}} onCreated={()=>setOpen(false)}/>:<main><p>TEST 来源列表</p><button onClick={()=>{setGeneration(n=>n+1);setOpen(true);}}>TEST 重开草稿</button></main>}</DocumentGuardContext.Provider>;
}
createRoot(window.document.getElementById("root")!).render(<Fixture/>);
