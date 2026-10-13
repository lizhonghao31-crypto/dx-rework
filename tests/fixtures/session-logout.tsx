// Actual shared logout components; this fixture uses only local synthetic HTTP sessions.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SessionBoundary,AuthGate,LoginPage } from '../../apps/web/src/auth.js';
import { Shell } from '../../apps/web/src/components.js';
import { usePatternDraftGuard } from '../../apps/web/src/use-pattern-draft-guard.js';
import '../../packages/ui/src/tokens.css';
import '../../packages/ui/src/components.css';
import '../../apps/web/src/styles.css';
import '../../apps/web/src/workflow-shell.css';
import '../../apps/web/src/dialog-visual-system.css';
import '../../apps/web/src/workflow-state-visual.css';
import '../../apps/web/src/ui-polish.css';

type TestWindow=Window&{dd?:unknown;DTFrameLogin?:unknown};
(window as TestWindow).dd={runtime:{permission:{requestAuthCode:({onSuccess}:{onSuccess:(result:{code:string})=>void})=>{
  void fetch('/__test/dd-request').then(()=>onSuccess({code:'TEST-mobile-code'}));
}}}};
(window as TestWindow).DTFrameLogin=(container:{id:string},parameters:{state:string},success:(result:{authCode:string;state:string})=>void)=>{
  const root=document.getElementById(container.id)!;
  const button=document.createElement('button');button.textContent='TEST 扫码确认';button.onclick=()=>success({authCode:'TEST-qr-code',state:parameters.state});root.replaceChildren(button);
};
function Business(){
  const [draft,setDraft]=useState('');usePatternDraftGuard(draft,false);
  return <AuthGate><Shell active="我的待办"><h1>TEST 受保护业务</h1><label>TEST 未保存内容<input value={draft} onChange={event=>setDraft(event.target.value)}/></label></Shell></AuthGate>;
}
createRoot(document.getElementById('root')!).render(<SessionBoundary>{location.pathname==='/auth/login'?<LoginPage/>:<Business/>}</SessionBoundary>);
