import {StrictMode,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {JOURNEY_STAGES,type OrderJourney} from '@dx-rework/contracts/digital-production-journey';
import {CockpitDocuments} from '../../apps/web/src/cockpit-documents.js';
import {invalidateSession} from '../../apps/web/src/auth-session.js';
import type {CockpitContext} from '../../apps/web/src/digital-journey-cockpit-model.js';
import '@dx-rework/ui/tokens.css';import '@dx-rework/ui/components.css';
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const scenario=new URLSearchParams(location.search).get('case')??'normal';
const state={actor:id(1),requests:[] as {path:string;method:string}[]};Object.assign(window,{directoryFixture:state});
const nativeFetch=window.fetch.bind(window);window.fetch=(input,init)=>{const headers=new Headers(init?.headers);headers.set('x-test-case',scenario);headers.set('x-test-actor',state.actor);state.requests.push({path:String(input),method:init?.method??'GET'});return nativeFetch(input,{...init,headers});};
const makeOrder=(n:number,round=1,revision=1):OrderJourney=>({id:id(n),sourceId:id(n),orderId:id(n+1),asOf:`2026-10-20T00:00:0${revision}.000Z`,designStyleNo:`TEST-${n}`,temporaryStyleNo:null,customer:'TEST',category:null,designer:null,styleName:null,merchandisers:[],orderNumbers:[],createdAt:'2026-10-19T00:00:00Z',deliveryDate:null,selectedRound:round,adoptedRound:1,sourceVersion:revision,instructionVersion:0,lines:[],links:[],stages:JOURNEY_STAGES.map(stage=>({...stage,state:'uncreated',nodes:[]})),progress:{development:null,bulk:null},hitReasons:[]});
function Harness(){const [order,setOrder]=useState(()=>makeOrder(10)),[context,setContext]=useState<CockpitContext>({selected:id(10),round:1});
 return <><nav><button onClick={()=>setContext(c=>({...c,selected:id(20)}))}>TEST选择另一单</button><button onClick={()=>{setOrder(makeOrder(20));setContext(c=>({...c,selected:id(20),round:1}));}}>TEST另一单到达</button><button onClick={()=>setContext(c=>({...c,round:2}))}>TEST选择第二轮</button><button onClick={()=>{setOrder(makeOrder(10,2));setContext(c=>({...c,selected:id(10),round:2}));}}>TEST第二轮到达</button><button onClick={()=>setOrder(o=>({...o,asOf:'2026-10-20T00:01:00.000Z',sourceVersion:2}))}>TEST资料刷新</button><button onClick={()=>{state.actor=id(8);invalidateSession();}}>TEST换账号</button></nav><CockpitDocuments order={order} context={context} onChange={patch=>setContext(c=>({...c,...patch}))}/></>;
}
createRoot(document.getElementById('root')!).render(<StrictMode><Harness/></StrictMode>);
