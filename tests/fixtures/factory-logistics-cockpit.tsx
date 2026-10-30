import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import type {OrderJourney,JourneyResult} from '@dx-rework/contracts/digital-production-journey';
import {JourneyReturnContextSchema} from '@dx-rework/contracts/digital-production-journey';
import type {FactoryFlowSheet} from '@dx-rework/contracts/factory-flow';
import {DigitalJourneyCockpit} from '../../apps/web/src/digital-journey-cockpit.js';
import {FactoryFlowPanel} from '../../apps/web/src/factory-flow-panel.js';
import '../../packages/ui/src/tokens.css';import '../../packages/ui/src/components.css';import '../../apps/web/src/styles.css';import '../../apps/web/src/workflow-shell.css';import '../../apps/web/src/ui-polish.css';
const input=Reflect.get(window,'pr4LogisticsInput') as {frames:Array<{name:string;factory:FactoryFlowSheet;detail:OrderJourney;listResult:JourneyResult}>};
const frame=input.frames[Number(new URLSearchParams(location.search).get('case'))];if(!frame)throw Error('Missing native logistics UI frame');
const requests:Array<{path:string;method:string}>=[];Reflect.set(window,'pr4LogisticsRequests',requests);
window.fetch=async(value,init)=>{
 const url=new URL(String(value),location.origin),method=init?.method??'GET';requests.push({path:url.pathname,method});
 if(method!=='GET')throw Error('Unexpected business write');
 if(url.pathname.endsWith(`/orders/${frame.factory.orderId}/factory-flow`))return Response.json(frame.factory);
 if(url.pathname.endsWith('/access/candidates'))return Response.json([]);
 return Response.json({message:'TEST unrelated read has no fixture'},{status:404});
};
function Fixture(){
 const [context,setContext]=useState(JourneyReturnContextSchema.parse({scope:'production'})),[factory,setFactory]=useState(false);
 return <><button type="button" onClick={()=>setFactory(!factory)}>TEST 原工厂页</button>{factory?<FactoryFlowPanel orderId={frame.factory.orderId} onClose={()=>setFactory(false)}/>:<DigitalJourneyCockpit data={frame.listResult} error="" detail={frame.detail} detailError="" detailLoading={false} context={context} onChange={patch=>setContext(current=>({...current,...patch}))} actions={null}/>}</>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
