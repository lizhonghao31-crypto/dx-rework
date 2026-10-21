import '../../apps/web/src/App.js';
import '../../apps/web/src/workflow-shell.css';
import '../../apps/web/src/workflow-state-visual.css';
import '../../apps/web/src/ui-polish.css';
import {StrictMode,useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {TodoReadBoundary,useTodoContentRead} from '../../apps/web/src/todo-content-read.js';
import {invalidateSession} from '../../apps/web/src/auth-session.js';
import {MyTodosPage} from '../../apps/web/src/my-todos-page.js';
import {Shell} from '../../apps/web/src/components.js';
import '@dx-rework/ui/tokens.css';import '@dx-rework/ui/components.css';
import '../../apps/web/src/styles.css';import '../../apps/web/src/my-todos.css';
const query=new URLSearchParams(location.search),scenario=query.get('case')??sessionStorage.getItem('TEST-case')??'normal',view=query.get('view')??(location.pathname.includes('my-tasks')?'list':'reader'),id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
sessionStorage.setItem('TEST-case',scenario);
const state={actor:id(1),requests:[] as {path:string;method:string;body:unknown}[]};Object.assign(window,{todoFixture:state});
let lostReceipt=false;const nativeFetch=window.fetch.bind(window);window.fetch=(input,init)=>{const url=new URL(String(input),location.origin),headers=new Headers(init?.headers);headers.set('x-test-case',scenario);headers.set('x-test-actor',state.actor);state.requests.push({path:url.pathname,method:init?.method??'GET',body:init?.body?JSON.parse(String(init.body)):null});const response=nativeFetch(input,{...init,headers});if(scenario==='lost'&&url.pathname.endsWith('/read')&&!lostReceipt){lostReceipt=true;return response.then(()=>{throw new TypeError('TEST已接收但客户端丢失回执');});}return response;};
function Body(){const [loaded,setLoaded]=useState(false),[failed,setFailed]=useState(false),[visible,setVisible]=useState(scenario!=='hidden');
 useEffect(()=>{let live=true;void fetch('/test/body').then(r=>{if(!r.ok)throw Error('TEST正文读取失败');return r.json();}).then(()=>{if(live)setLoaded(true);}).catch(()=>{if(live)setFailed(true);});void fetch('/test/candidates').catch(()=>undefined);return()=>{live=false;};},[]);
 const ref=useTodoContentRead({routeName:'digital_production_task',entityId:id(scenario==='wrong-entity'?9:2),developmentRound:scenario==='wrong-round'?2:1},loaded);
 return <><button onClick={()=>setVisible(true)}>显示正文</button><div hidden={!visible}><section ref={ref}>{loaded?<h1>TEST真实主体已展示</h1>:failed?<p role="alert">TEST正文读取失败</p>:<p>TEST正文读取中</p>}</section></div></>;
}
function Harness(){return <><button onClick={()=>{state.actor=id(8);invalidateSession();}}>TEST切换账号</button><TodoReadBoundary><Body/></TodoReadBoundary></>;}
createRoot(document.getElementById('root')!).render(<StrictMode>{view==='list'?<MyTodosPage/>:view==='cockpit'?<Shell active="管理座舱"><h1>TEST座舱原壳</h1></Shell>:<Harness/>}</StrictMode>);
