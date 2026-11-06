import {createRoot} from 'react-dom/client';
import {useState} from 'react';
import {MyTodosPage} from '../../apps/web/src/my-todos-page.js';
import {DigitalProductionPage} from '../../apps/web/src/digital-production-page.js';
import {ShortLeadPanel} from '../../apps/web/src/short-lead-panel.js';
import '../../packages/ui/src/tokens.css';
import '../../packages/ui/src/components.css';
import '../../apps/web/src/styles.css';
import '../../apps/web/src/workflow-shell.css';
import '../../apps/web/src/dialog-visual-system.css';
import '../../apps/web/src/workflow-state-visual.css';
import '../../apps/web/src/ui-polish.css';
function TestSourceSwitch(){const query=new URLSearchParams(location.search),a=query.get('race')!,b=query.get('other')!,[source,setSource]=useState(a);return <><button onClick={()=>setSource(a)}>TEST 选择来源A</button><button onClick={()=>setSource(b)}>TEST 选择来源B</button><ShortLeadPanel sourceId={source} readOnly defaultOpen/></>;}
createRoot(document.getElementById('root')!).render(<main className="dx-production-ui"><p>TEST 原生短交期组件、原认证及隔离数据库验证</p>{new URLSearchParams(location.search).has('race')?<TestSourceSwitch/>:location.pathname==='/ui/my-tasks'?<MyTodosPage/>:<DigitalProductionPage/>}</main>);
