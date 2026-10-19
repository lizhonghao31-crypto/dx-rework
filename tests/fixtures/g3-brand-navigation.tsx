import '../../apps/web/src/App.js';
import {createRoot} from 'react-dom/client';
import {verifySession} from '../../apps/web/src/auth.js';
import {Shell} from '../../apps/web/src/components.js';
import '@dx-rework/ui/tokens.css';import '@dx-rework/ui/components.css';import '../../apps/web/src/styles.css';import '../../apps/web/src/workflow-shell.css';import '../../apps/web/src/workflow-state-visual.css';import '../../apps/web/src/ui-polish.css';
const role=new URLSearchParams(location.search).get('fixtureRole')??'root';
const user={id:'00000000-0000-4000-8000-000000000001',displayName:'TEST 导航账号',isRoot:role==='root',businessRoles:role==='root'?['root_superuser']:role==='worker'?['worker']:['finance_read'],capabilities:role==='worker'?['work:report','todo:view']:role==='finance'?['wage:view','wage:export','report:view','report:export','todo:view']:['todo:view','work:report']};
window.fetch=async(input,init)=>{const path=String(input),method=init?.method??'GET';if(path.endsWith('auth/logout')&&method==='POST'){console.log('G3_LOCAL_LOGOUT');return new Response(null,{status:204});}if(method!=='GET')throw Error('Unexpected local mutation');if(path.endsWith('auth/me'))return Response.json({status:'authorized',user});if(path.includes('todo')&&path.includes('count'))return Response.json({pendingCount:0});return Response.json({error:{message:'隔离页面未配置该读取'}},{status:404});};
void verifySession().then(()=>createRoot(document.getElementById('root')!).render(<Shell active="我的待办"><h1>TEST 导航布局</h1><p>隔离角色、品牌与退出入口核对。</p></Shell>));
