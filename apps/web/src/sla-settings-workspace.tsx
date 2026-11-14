import {useEffect,useState,type ReactNode} from 'react';
import {registerSessionInvalidator,sessionCacheVersion} from './auth-session.js';
import {SpecialCraftLibrary} from './special-craft-library.js';
import {SlaSettingsSetEditor} from './sla-settings-set-editor.js';
import {SlaIndependentCalculator} from './sla-independent-calculator.js';
import {OrderTimeStandardEditor} from './order-time-standard-editor.js';
import {OrderTimeCalculator} from './order-time-calculator.js';
import type {OrderTimeSettingsRead} from '@dx-rework/contracts/order-time-settings';
import {digitalRequest,DigitalRequestError} from './digital-production-api.js';
import './order-time-settings.css';
// Compatibility for the existing standalone editors; the workspace uses the
// three approved business workspaces below.
export type SlaSettingsTab='standard'|'reminders'|'development';
const noAuthorityChange=()=>undefined;
const baseTabs=[['settings','时效设置'],['calculation','时效演算'],['customers','客户跟单'],['crafts','特殊工艺库']] as const;
type Tab=typeof baseTabs[number][0]|'risks';
function SettingsWorkspaces({readOnly,customerControl,riskControl,onAuthorityChanged,onHistoryChange}:{readOnly:boolean;customerControl?:ReactNode;riskControl?:ReactNode;onAuthorityChanged():void;onHistoryChange?(open:boolean):void}){
 const tabs:readonly (readonly [Tab,string])[]=riskControl?[...baseTabs,['risks','生产风险提醒']]:baseTabs;
 const [tab,setTab]=useState<Tab>('settings'),[calculationVisited,setCalculationVisited]=useState(false),[historyOpen,setHistoryOpen]=useState(false),[craftsVisited,setCraftsVisited]=useState(false);
 const [timeSettings,setTimeSettings]=useState<OrderTimeSettingsRead|null>(null),[timeError,setTimeError]=useState(''),[reload,setReload]=useState(0);
 useEffect(()=>{let live=true;const controller=new AbortController();setTimeError('');void digitalRequest<OrderTimeSettingsRead>('order-time-settings','GET',undefined,undefined,{signal:controller.signal}).then(value=>{if(live)setTimeSettings(value);}).catch(reason=>{if(live&&reason.name!=='AbortError'){setTimeError(reason.message);if(reason instanceof DigitalRequestError&&[401,403].includes(reason.status??0))onAuthorityChanged();}});return()=>{live=false;controller.abort();};},[reload,onAuthorityChanged]);
 const enhanced=timeSettings&&(timeSettings.enabled||timeSettings.record);
 useEffect(()=>{onHistoryChange?.(historyOpen&&tab==='settings');},[historyOpen,tab,onHistoryChange]);
 return <div className="sla-settings-workspace r5-settings">
  <nav className="r5-workspace-tabs" aria-label="生产管理设置分类"><div role="tablist" aria-label="设置类别">{tabs.map(([key,label],index)=><button type="button" role="tab" key={key} id={'sla-tab-'+key} aria-selected={tab===key} aria-controls={'sla-panel-'+key} tabIndex={tab===key?0:-1} onKeyDown={event=>{
   const next=event.key==='ArrowRight'?(index+1)%tabs.length:event.key==='ArrowLeft'?(index+tabs.length-1)%tabs.length:event.key==='Home'?0:event.key==='End'?tabs.length-1:null;
   if(next!==null){event.preventDefault();const value=tabs[next]![0];setTab(value);if(value==='crafts')setCraftsVisited(true);if(value==='calculation')setCalculationVisited(true);document.getElementById('sla-tab-'+value)?.focus();}
  }} onClick={()=>{setTab(key);if(key==='crafts')setCraftsVisited(true);if(key==='calculation')setCalculationVisited(true);}}>{label}</button>)}</div></nav>
  {riskControl&&<div role="tabpanel" id="sla-panel-risks" aria-labelledby="sla-tab-risks" hidden={tab!=='risks'}>{tab==='risks'&&riskControl}</div>}
  {timeError&&<p role="alert">{timeError}<button type="button" className="r5-link" onClick={()=>setReload(v=>v+1)}>重试</button></p>}
  {!timeSettings&&!timeError&&<p role="status">正在读取设置…</p>}
  <div role="tabpanel" id="sla-panel-settings" aria-labelledby="sla-tab-settings" hidden={tab!=='settings'}>{timeSettings&&(enhanced?<OrderTimeStandardEditor initial={timeSettings} readOnly={readOnly} onAuthorityChanged={onAuthorityChanged} onSaved={setTimeSettings}/>:<SlaSettingsSetEditor readOnly={readOnly} onAuthorityChanged={onAuthorityChanged} onHistoryChange={setHistoryOpen}/>)}</div>
  <div role="tabpanel" id="sla-panel-calculation" aria-labelledby="sla-tab-calculation" hidden={tab!=='calculation'}>{calculationVisited&&timeSettings&&(enhanced?<OrderTimeCalculator initial={timeSettings}/>:<SlaIndependentCalculator onAuthorityChanged={onAuthorityChanged}/>)}</div>
  {craftsVisited&&<div hidden={tab!=='crafts'} role="tabpanel" id="sla-panel-crafts" aria-labelledby="sla-tab-crafts"><SpecialCraftLibrary readOnly={readOnly} onAuthorityChanged={onAuthorityChanged}/></div>}
  <div role="tabpanel" id="sla-panel-customers" aria-labelledby="sla-tab-customers" hidden={tab!=='customers'}>{customerControl??<p>当前岗位无权读取客户跟单配置。</p>}</div>
 </div>;
}
export function SlaSettingsWorkspace({readOnly=false,customerControl,riskControl,onAuthorityChanged=noAuthorityChange,onHistoryChange}:{readOnly?:boolean;customerControl?:ReactNode;riskControl?:ReactNode;onAuthorityChanged?():void;onHistoryChange?(open:boolean):void}){
 const [identity,setIdentity]=useState(sessionCacheVersion);
 useEffect(()=>registerSessionInvalidator(()=>setIdentity(sessionCacheVersion())),[]);
 return <SettingsWorkspaces key={identity} readOnly={readOnly} customerControl={customerControl} riskControl={riskControl} onAuthorityChanged={onAuthorityChanged} {...(onHistoryChange?{onHistoryChange}:{})}/>;
}
