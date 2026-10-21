// Actual product components with synthetic, intercepted requests. No business service or database.
import {useState} from "react";
import {createRoot} from "react-dom/client";
import {DevelopmentCreateForm} from "../../apps/web/src/digital-development-create-form.js";
import {initialDevelopmentDocument} from "../../apps/web/src/digital-development-editing.js";
import {initialDevelopmentOrder as createOrder} from "../../apps/web/src/digital-development-create-form.js";
import {canLeaveInternalPage} from "../../apps/web/src/internal-navigation.js";
import {SaveDevelopmentSchema,type DevelopmentSheet} from "@dx-rework/contracts/digital-development";
import "../../packages/ui/src/tokens.css";
import "../../packages/ui/src/components.css";
import "../../apps/web/src/styles.css";
import "../../apps/web/src/digital-development-workspace.css";

const id=(suffix:number)=>`00000000-0000-4000-8000-${String(suffix).padStart(12,"0")}`;
const categories=[{priceId:id(2),name:"TEST 短袖上衣",unit:"件"},{priceId:id(3),name:"TEST 长裤",unit:"件"}];
const order=createOrder([]);
order.designStyleNo="TEST-DRAFT-PATTERN";order.customerCode="TEST";order.orderDate="2026-10-17";
order.lines=[1,2,3].map(index=>({formalPoNo:`TEST-PO-${index}`,customerWarehouseArrivalDate:"2099-12-31",poNumber:null,formalStyleNo:null,temporaryStyleNo:null,color:`TEST 颜色${index}`,colorForeign:null,deliveryDate:null,sizes:[{size:"M",quantity:String(index*10)}]}));
const initialDocument={...initialDevelopmentDocument(),quantity:1,sizeQuantities:[1],sampleSize:"M",sizes:["M"],measurements:[{name:"胸围",values:["60"]}],instructions:"TEST 保留说明",customerOrderDraft:{withOrder:true,order}};
const params=new URLSearchParams(location.search),p03=params.has("p03"),stress=params.has("stress");
if(p03){
 initialDocument.quantity=3;initialDocument.sizes=["M","L","XL"];initialDocument.sizeQuantities=[2,1,0];initialDocument.orderDate="2026-10-17";
 initialDocument.measurements=Array.from({length:stress?30:3},(_,index)=>({name:index===0?"胸围":`TEST项目${index+1}`,values:["60","64","68"]}));
 initialDocument.materials=Array.from({length:stress?100:1},(_,index)=>({...initialDocument.materials[0]!,materialId:id(100+index),label:`TEST材料${index+1}`,name:`TEST长品名${index+1}`,specification:"TEST 150cm / 40支",available:true}));
 initialDocument.files=Array.from({length:stress?10:1},(_,index)=>({attachmentId:id(500+index),kind:"款图" as const}));
 order.lines=[{...order.lines[0]!,sizes:[{size:"M",quantity:"400"},{size:"L",quantity:"200"}]}];
 if(params.has("legacyPo"))order.lines=[{...order.lines[0]!,sizes:[{size:"M",quantity:"400"},{size:"XS",quantity:"0"}]},{...order.lines[0]!,formalPoNo:"TEST旧PO2",color:"TEST旧颜色",sizes:[{size:"L",quantity:"200"}]}];
 initialDocument.customerOrderDraft={withOrder:!params.has("noOrder"),order};
}
const state={
  saved:{sourceId:id(1),designStyleNo:order.designStyleNo,temporaryStyleNo:null,customerCode:"TEST",developmentType:"头版",designerName:"TEST 设计师",version:1,status:"draft",document:initialDocument,publishedAt:null,taskId:null,canEdit:true,materialEvents:[]} as DevelopmentSheet,
  requests:[] as {path:string;method:string;body:unknown}[],
  failNextSave:false,failQuote:false,quoteVersion:1,quoteAmount:"40.000",cancelled:0,created:0,leaveResult:null as boolean|null,
};
Object.assign(window,{developmentDraftFixture:state,checkDevelopmentDraftLeave:async()=>{state.leaveResult=await canLeaveInternalPage();}});
window.fetch=async(input,init)=>{
  const path=String(input),method=init?.method??"GET",body=init?.body?JSON.parse(String(init.body)):null;
  state.requests.push({path,method,body});
  if(path.includes("/attachments/")){if(path.endsWith("/metadata"))return Response.json({filename:"TEST款图.png",mimeType:"image/png",sizeBytes:68});return new Response(Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7V8AAAAASUVORK5CYII="),c=>c.charCodeAt(0)),{headers:{"content-type":"image/png"}});}
  if(path.endsWith("/category-options"))return Response.json(categories);
  if(path.includes("/category-options/")&&path.endsWith("/quote")){
    if(state.failQuote)return Response.json({error:{message:"TEST 价格读取失败"}},{status:503});
    const category=categories.find(item=>path.includes(item.priceId))!;
    return Response.json({...category,amount:state.quoteAmount,version:state.quoteVersion});
  }
  if(path.endsWith(`/sources/${id(1)}/development`)){
    if(method==="PUT"){
      if(state.failNextSave){state.failNextSave=false;return Response.json({error:{message:"TEST 保存失败"}},{status:503});}
      const parsed=SaveDevelopmentSchema.parse(body);
      if(parsed.expectedVersion!==state.saved.version)return Response.json({error:{message:"TEST 版本冲突"}},{status:409});
      state.saved={...state.saved,version:state.saved.version+1,document:structuredClone(parsed.document)};
    }
    return Response.json(state.saved);
  }
  throw new Error(`Unmapped synthetic request: ${method} ${path}`);
};
function Fixture(){
  const [open,setOpen]=useState(true),[generation,setGeneration]=useState(0);
  return open?<DevelopmentCreateForm key={generation} intent={params.has("noOrder")?"development":"certain_order"} existingDraft={structuredClone(state.saved)} customers={[{code:"TEST",name:"TEST 客户",productGroups:["男装"],defaultMerchandiserId:null,defaultMerchandiserName:null}]} minimumDate="2026-11-17" serverToday="2026-10-17" onCancel={()=>{state.cancelled++;setOpen(false);}} onCreated={()=>state.created++}/>:<main><p>TEST 来源列表</p><button onClick={()=>{setGeneration(value=>value+1);setOpen(true);}}>TEST 重开草稿</button></main>;
}
createRoot(document.getElementById("root")!).render(<Fixture/>);
