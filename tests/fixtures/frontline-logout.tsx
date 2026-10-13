import { createRoot } from 'react-dom/client';
import { App } from '../../apps/web/src/App.js';
import '../../packages/ui/src/tokens.css';
import '../../packages/ui/src/components.css';
import '../../apps/web/src/styles.css';
import '../../apps/web/src/workflow-shell.css';
import '../../apps/web/src/dialog-visual-system.css';
import '../../apps/web/src/ui-polish.css';
let authorized=true;
const warehouse=location.pathname==='/ui/receiving';
window.fetch=async(input,init)=>{
 const path=String(input);
 if(path.endsWith('/auth/me'))return Response.json({status:'authorized',user:{id:'00000000-0000-4000-8000-000000000001',displayName:'TEST bare frontline',isRoot:false,businessRoles:warehouse?['warehouse_receiver']:['worker'],capabilities:warehouse?['receiving:create','receiving:packing_manage','tools:user']:['work:report']}},{status:authorized?200:401});
 if(path.endsWith('/auth/logout')&&init?.method==='POST'){authorized=false;return new Response(null,{status:204});}
 if(path.includes('/frontline/work-tasks'))return Response.json({kind:'worker',items:new URLSearchParams(location.search).get('single')==='1'?[{reworkOrderId:'00000000-0000-4000-8000-000000000002',reworkNo:'TEST-REWORK',styleNo:'TEST-WORKER',orderNo:null,images:[],processNames:['TEST上数'],status:'in_progress'}]:[]});
 if(path.includes('/receiving/cutting-options')||path.includes('/receiving/repeat-options'))return Response.json({orders:[]});
 return Response.json({error:{message:'TEST unmapped route'}},{status:404});
};
createRoot(document.getElementById('root')!).render(<App/>);
