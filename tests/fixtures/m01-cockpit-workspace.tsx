// Original Page, instruction editor, auth invalidation and source HTTP fixture.
// Responses are synthetic TEST records; deferred promises deliberately ignore abort
// so the actual components must reject stale success, catch and finally paths.
import './node-materials-page.js';
import '@dx-rework/ui/production.css';
import '../../apps/web/src/digital-journey-cockpit.css';
import type {OrderJourney,JourneyResult} from '@dx-rework/contracts/digital-production-journey';
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
document.documentElement.classList.add('dx-production-ui');
const original=window.fetch.bind(window),pending=new Map<number,(patch:{status?:number;data?:unknown})=>void>();
type Entry={id:number;resource:string;query:string;search:string;page:number;released:boolean;waiting:boolean};
const control={requests:[] as Entry[],hold:'' as string,shape:'normal',
 release:(n:number,patch:{status?:number;data?:unknown}={})=>{const entry=control.requests.find(item=>item.id===n);if(!entry||!pending.has(n))throw Error('TEST unknown pending request '+n);entry.released=true;entry.waiting=false;pending.get(n)!(patch);pending.delete(n);},
};
Object.assign(window,{m01Fixture:control});
function richOrder(value:OrderJourney):OrderJourney{
 const order=structuredClone(value),isQ=order.id===id(1),prefix=isQ?'TEST-Q':'TEST-S',count=isQ?20:2;
 order.designStyleNo=prefix;order.customer='TEST长客户名称用于验证中文换行与可达性';
 order.lines=Array.from({length:count},(_,index)=>({id:id((isQ?1000:2000)+index),po:`${prefix}-PO${index+1}`,color:`TEST颜色${index+1}`,formalStyleNo:null,temporaryStyleNo:null,orderedQuantity:control.shape==='F'&&index===0?4:1}));
 order.poDeliveryDates=order.lines.map((line,index)=>({lineId:line.id,position:index+1,poNumber:line.po,color:line.color,customerWarehouseArrivalDate:index===count-1?null:`2027-03-${String(10+index%10).padStart(2,'0')}`,factoryDeliveryDate:index===1?'2027-03-01':'2027-03-09',sampleTargetDate:null}));
 const prep=order.stages.find(stage=>stage.key==='preparation')!,template=prep.nodes.find(node=>node.key==='bulk_pattern')!;
 for(let index=0;index<(isQ?30:4);index++)prep.nodes.push({...structuredClone(template),instanceId:`${prefix}-extra-${index}`,label:`${prefix}适用任务${index+1}`,state:index%3===0?'completed':'active',risks:index<6?['overdue']:[],expectedAt:'2026-11-01T08:00:00Z',expectedPrecision:'instant',actualAt:index%3===0?'2026-11-02T08:00:00Z':null});
 order.currentRiskNodes=prep.nodes.filter(node=>node.risks.length);order.currentRiskNodes.push({...structuredClone(template),instanceId:prefix+'-production-risk',label:'TEST其他阶段生产逾期',stage:'production',state:'blocked',risks:['overdue','blocked']});
 order.riskHistory=[];order.currentDeliveryRisks=[];
 order.operationLog={asOf:order.asOf!,items:[{id:prefix+'-audit',at:'2026-11-02T08:00:00Z',actor:{id:id(7),name:'TEST跟单'},object:'本单原记录',action:'查看用测试记录'}],nextCursor:null};
 if(control.shape==='deleted')prep.nodes=prep.nodes.filter(node=>node.instanceId!=='TEST-Q-extra-1');
 if(control.shape==='F'){
  order.lines=order.lines.slice(0,1);order.poDeliveryDates=order.poDeliveryDates.slice(0,1);
  order.businessProgress={ruleVersion:'journey-business-v1',asOf:order.asOf!,requirements:[],applicable:4,completed:2,unknown:0,ratio:.5,stages:[],plan:{status:'not_adopted',planId:null,revision:null,covered:0,missing:4,due:0,outstandingDue:[],reasons:[]},quantities:{revision:'TEST-F',factoryAttribution:'unknown',lines:[{lineId:order.lines[0]!.id,demand:4,received:2,inspected:2,qualified:2,packed:2,remainingReceipt:2,remainingShipment:2,qualityGap:0,qualityConflict:false,factoryAttribution:'unknown',reasons:['TEST逐厂实收未留对应凭证']}]}};
 }
 return order;
}
window.fetch=async(input,init)=>{
 const url=new URL(String(input),location.origin),path=url.pathname,resource=path.endsWith('/node-materials')?'material':/\/journeys\//.test(path)?'detail':path.endsWith('/journeys')?'list':path.endsWith('/series-plan')?'plan':'other';
 const response=await original(input,init);if(resource==='other'||!response.ok)return response;
 const entry:Entry={id:control.requests.length+1,resource,query:url.search,search:url.searchParams.get('search')??'',page:Number(url.searchParams.get('page')??1),released:false,waiting:false};control.requests.push(entry);
 let data:unknown=await response.json();
 if(resource==='detail')data=richOrder(data as OrderJourney);
 if(resource==='list'){
  const list=data as JourneyResult,total=entry.search==='A'?31:entry.search==='B'?47:entry.search==='C'?19:2;
  data={...list,page:entry.page,total,asOf:`2026-11-02T08:${String(Math.floor(entry.id/60)).padStart(2,'0')}:${String(entry.id%60).padStart(2,'0')}Z`,summary:{...list.summary,all:total,active:total},items:list.items.map(item=>({...richOrder(item),designStyleNo:(item.id===id(1)?'TEST-Q':'TEST-S')+(entry.search?`-${entry.search}-r${entry.id}`:'')}))};
 }
 if(control.hold===resource){const patch=await new Promise<{status?:number;data?:unknown}>(resolve=>{pending.set(entry.id,resolve);entry.waiting=true;});if(patch.status)return Response.json({error:{message:'TEST受控读取失败'+patch.status}},{status:patch.status});if(patch.data!==undefined)data=patch.data;}
 entry.released=true;return Response.json(data);
};
