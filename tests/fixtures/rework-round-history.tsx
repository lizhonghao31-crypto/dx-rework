import '../../apps/web/src/App.js';
import {createRoot} from 'react-dom/client';
import {PatternOrderDetailSchema,type PatternOrderDetail} from '@dx-rework/contracts/pattern-orders';
import {PatternRoomOrderDetailPage} from '../../apps/web/src/pattern-room-orders-page.js';
import {Shell} from '../../apps/web/src/components.js';
import '@dx-rework/ui/tokens.css';import '@dx-rework/ui/components.css';import '../../apps/web/src/styles.css';import '../../apps/web/src/workflow-shell.css';import '../../apps/web/src/ui-polish.css';
const input=Reflect.get(window,'pr3HistoryInput') as {frames:Array<{mode:string;index:number;detail:PatternOrderDetail}>};
const query=new URLSearchParams(location.search),selected=input.frames[Number(query.get('case'))];
if(!selected)throw Error('Missing isolated PostgreSQL frame');
const detail=structuredClone(selected.detail);
if(query.get('unknown')==='1'){detail.attachments=[];detail.historicalView={...detail.historicalView!,missingFacts:true,reason:'TEST历史附件归属或绑定审计时间未留证'};}
PatternOrderDetailSchema.parse(detail);
const state={requests:[] as Array<{path:string;method:string}>};Reflect.set(window,'pr3HistoryState',state);
window.fetch=async(input,init)=>{
 const url=new URL(String(input),location.origin),method=init?.method??'GET';state.requests.push({path:url.pathname+url.search,method});
 if(method!=='GET')throw Error('Unexpected business write in historical view');
 if(url.pathname.endsWith('/auth/me'))return Response.json({status:'authorized',user:{id:detail.creatorId,displayName:'TEST isolated reader',isRoot:true,businessRoles:['root_superuser'],capabilities:['pattern_room:orders:view']}});
 if(url.pathname.endsWith(`/pattern-room/orders/${detail.orderId}`)){
  if(url.searchParams.get('round')!==detail.currentRoundId||url.searchParams.get('node')!=='completed')return Response.json({error:{message:'TEST wrong original round'}},{status:409});
  return Response.json(detail);
 }
 return Response.json([]);
};
createRoot(document.getElementById('root')!).render(<Shell><PatternRoomOrderDetailPage orderId={detail.orderId}/></Shell>);
