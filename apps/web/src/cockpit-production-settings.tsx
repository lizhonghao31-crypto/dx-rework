import {SeriesSettings} from './series-settings.js';
import {useEffect,useState} from 'react';
import {PageHeader} from '@dx-rework/ui/production';
import {JOURNEY_NODES} from '@dx-rework/contracts/digital-production-journey';
import {canReadDigitalProductionSettings,type DigitalAccessOptions} from './digital-production-access-panel.js';
import {DigitalCockpitPersonnel} from './digital-cockpit-personnel.js';
import {digitalRequest} from './digital-production-api.js';
import {SlaSettingsWorkspace} from './sla-settings-workspace.js';
import {verifySession} from './auth.js';
import {registerSessionInvalidator,refreshSessionResult} from './auth-session.js';
import './cockpit-production-settings.css';
export const cockpitPolicyStage=(key:string)=>JOURNEY_NODES.find(node=>node.key===(key==="bulk_cutting_external"?"bulk_cutting":key==="production_sheet"?"production_instruction":key))?.stage??"other";
export function CockpitProductionSettings(){
 const [access,setAccess]=useState<DigitalAccessOptions|null>(null),[error,setError]=useState('');
 const [revision,setRevision]=useState(0);
 const refreshAuthority=()=>{setAccess(null);setRevision(value=>value+1);};
 useEffect(()=>registerSessionInvalidator(refreshAuthority),[]);
 useEffect(()=>{const controller=new AbortController();setAccess(null);setError('');void(async()=>{const session=revision?(await refreshSessionResult()).session:await verifySession();if(controller.signal.aborted)return;if(session==='denied')throw Error('登录状态尚未确认，请重新登录后读取设置');const value=await digitalRequest<DigitalAccessOptions>('access/options','GET',undefined,undefined,{signal:controller.signal});if(!controller.signal.aborted)setAccess(value);})().catch(e=>{if(!controller.signal.aborted&&e.name!=='AbortError')setError(e.message);});return()=>controller.abort();},[revision]);
 return <div className="cockpit-settings"><PageHeader title="生产管理设置"/>
  {error&&<p role="alert">{error}</p>}
  {!access&&!error&&<p>正在读取设置…</p>}
  {access&&!canReadDigitalProductionSettings(access)&&!access.customers&&<p>当前岗位无权访问生产管理设置。</p>}
  {(access?.customers||access?.roles?.includes('pmc'))&&<details className="cockpit-settings-node-section"><summary>客户默认跟单</summary><DigitalCockpitPersonnel orderId={null} readOnly={!access?.customers} onChanged={()=>undefined}/></details>}
  {access&&canReadDigitalProductionSettings(access)&&<><SlaSettingsWorkspace readOnly={!access.manage} onAuthorityChanged={refreshAuthority}/><SeriesSettings readOnly={!access.manage}/></>}
 </div>;
}
