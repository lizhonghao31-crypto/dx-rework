import {createRoot} from 'react-dom/client';
import {OrderBoardPage} from '../../apps/web/src/order-board-page.js';
import '@dx-rework/ui/tokens.css';import '@dx-rework/ui/components.css';
const scenario=new URLSearchParams(location.search).get('case')??'packing-unknown',nativeFetch=fetch.bind(window),state={requests:[] as {method:string;url:string;body:unknown;key:string|null}[]};Object.assign(window,{receivingBoardFixture:state});
window.fetch=(input,init)=>{const headers=new Headers(init?.headers);headers.set('x-test-case',scenario);state.requests.push({method:init?.method??'GET',url:String(input),body:typeof init?.body==='string'?JSON.parse(init.body):null,key:headers.get('idempotency-key')});return nativeFetch(input,{...init,headers});};
createRoot(document.getElementById('root')!).render(<OrderBoardPage/>);
