import {useEffect,useState,type ReactNode} from 'react';
import {registerSessionInvalidator,sessionCacheVersion} from './auth-session.js';
import {SlaSettingsSetEditor} from './sla-settings-set-editor.js';
import {SlaIndependentCalculator} from './sla-independent-calculator.js';
// Compatibility for the existing standalone editors; the workspace uses the
// three approved business workspaces below.
export type SlaSettingsTab='standard'|'reminders'|'development';
const noAuthorityChange=()=>undefined;
const tabs=[['settings','开发周期&时效'],['calculation','时效演算'],['customers','客户跟单配置']] as const;
type Tab=typeof tabs[number][0];
function SettingsWorkspaces({readOnly,customerControl,onAuthorityChanged,onHistoryChange}:{readOnly:boolean;customerControl?:ReactNode;onAuthorityChanged():void;onHistoryChange?(open:boolean):void}){
 const [tab,setTab]=useState<Tab>('settings'),[calculationVisited,setCalculationVisited]=useState(false),[historyOpen,setHistoryOpen]=useState(false);
 useEffect(()=>{onHistoryChange?.(historyOpen&&tab==='settings');},[historyOpen,tab,onHistoryChange]);
 return <div className="sla-settings-workspace">
  <nav className="sla-workspace-tabs" aria-label="生产管理设置分类"><div role="tablist" aria-label="设置类别">{tabs.map(([key,label],index)=><button type="button" role="tab" key={key} id={'sla-tab-'+key} aria-selected={tab===key} aria-controls={'sla-panel-'+key} tabIndex={tab===key?0:-1} onKeyDown={event=>{
   const next=event.key==='ArrowRight'?(index+1)%3:event.key==='ArrowLeft'?(index+2)%3:event.key==='Home'?0:event.key==='End'?2:null;
   if(next!==null){event.preventDefault();const value=tabs[next]![0];setTab(value);if(value==='calculation')setCalculationVisited(true);document.getElementById('sla-tab-'+value)?.focus();}
  }} onClick={()=>{setTab(key);if(key==='calculation')setCalculationVisited(true);}}>{label}</button>)}</div></nav>
  <div role="tabpanel" id="sla-panel-settings" aria-labelledby="sla-tab-settings" hidden={tab!=='settings'}><SlaSettingsSetEditor readOnly={readOnly} onAuthorityChanged={onAuthorityChanged} onHistoryChange={setHistoryOpen}/></div>
  <div role="tabpanel" id="sla-panel-calculation" aria-labelledby="sla-tab-calculation" hidden={tab!=='calculation'}>{calculationVisited&&<SlaIndependentCalculator onAuthorityChanged={onAuthorityChanged}/>}</div>
  <div role="tabpanel" id="sla-panel-customers" aria-labelledby="sla-tab-customers" hidden={tab!=='customers'}>{customerControl??<p>当前岗位无权读取客户跟单配置。</p>}</div>
 </div>;
}
export function SlaSettingsWorkspace({readOnly=false,customerControl,onAuthorityChanged=noAuthorityChange,onHistoryChange}:{readOnly?:boolean;customerControl?:ReactNode;onAuthorityChanged?():void;onHistoryChange?(open:boolean):void}){
 const [identity,setIdentity]=useState(sessionCacheVersion);
 useEffect(()=>registerSessionInvalidator(()=>setIdentity(sessionCacheVersion())),[]);
 return <SettingsWorkspaces key={identity} readOnly={readOnly} customerControl={customerControl} onAuthorityChanged={onAuthorityChanged} {...(onHistoryChange?{onHistoryChange}:{})}/>;
}
