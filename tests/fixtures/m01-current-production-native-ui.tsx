import {App} from '../../apps/web/src/App.js';
import {createRoot} from 'react-dom/client';
import {DIGITAL_PRODUCTION_ROLES} from '../../apps/web/src/platform-modules.js';
import {AuthGate} from '../../apps/web/src/auth.js';
import {DigitalAnalysisPage} from '../../apps/web/src/digital-analysis-page.js';
import {DigitalProductionPage} from '../../apps/web/src/digital-production-page.js';
import '../../packages/ui/src/tokens.css';
import '../../packages/ui/src/components.css';
import '../../apps/web/src/styles.css';
import '../../apps/web/src/workflow-shell.css';
import '../../apps/web/src/dialog-visual-system.css';
import '../../apps/web/src/workflow-state-visual.css';
import '../../apps/web/src/responsibility-determination.css';
import '../../apps/web/src/ui-polish.css';
import '../../apps/web/src/scoped-select-arrow.css';
const testQuery=new URLSearchParams(location.search),testFullApp=testQuery.has('testFullApp');
if(testFullApp){testQuery.delete('testFullApp');history.replaceState(history.state,'',location.pathname+'?'+testQuery);}
createRoot(document.getElementById('root')!).render(testFullApp?<App/>:<main className="dx-production-ui"><p>TEST 当前生产原生组件、原认证、隔离业务样本；不代表经营评价</p><AuthGate requiredAnyOf={DIGITAL_PRODUCTION_ROLES.map(requiredRole=>({requiredRole,requiredCapability:'report:view'}))}>{location.pathname==='/ui/digital-analysis'?<DigitalAnalysisPage/>:<DigitalProductionPage/>}</AuthGate></main>);
