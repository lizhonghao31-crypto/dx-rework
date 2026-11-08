import {useCallback,useEffect,useMemo,useRef,useState,type ReactNode} from 'react';
import type {DigitalSlaValues} from '@dx-rework/contracts/digital-sla';
import type {DevelopmentCycleValues} from '@dx-rework/contracts/digital-development-technical';
import {registerSessionInvalidator,sessionCacheVersion} from './auth-session.js';
import {SlaHistoryWorkspace} from './sla-history-workspace.js';
import {SlaStandardEditor,type SlaHistoryEditorBridge} from './sla-standard-editor.js';
import {DevelopmentCycleSettings} from './development-cycle-settings.js';
import {SlaCalculationPreviewPanel,type SlaCalculationHandle} from './sla-calculation-preview.js';
import type {SlaStageTiming} from './sla-calculation-preview-model.js';
import type {SlaDraftSnapshot} from './sla-settings-draft.js';
import {SlaAdjustmentPreviewHost,type SlaAdjustmentComparison} from './sla-adjustment-preview.js';

export type SlaSettingsTab='standard'|'reminders'|'development';
const noAuthorityChange=()=>undefined;
function SettingsDrafts({readOnly,customerControl,onAuthorityChanged=noAuthorityChange,onHistoryChange}:{onHistoryChange?(open:boolean):void;customerControl?:ReactNode;readOnly:boolean;onAuthorityChanged?():void}){
 const [unified,setUnified]=useState<SlaDraftSnapshot<DigitalSlaValues>|null>(null),[development,setDevelopment]=useState<SlaDraftSnapshot<DevelopmentCycleValues>|null>(null),[summary,setSummary]=useState('正在读取本次流程依据');
 const [unifiedSettled,setUnifiedSettled]=useState(false),[developmentSettled,setDevelopmentSettled]=useState(false),[filter,setFilter]=useState({stage:2,query:''});
 const [unifiedWriting,setUnifiedWriting]=useState(false),[developmentWriting,setDevelopmentWriting]=useState(false);
 const [tab,setTab]=useState<SlaSettingsTab>('standard'),[historyOpen,setHistoryOpen]=useState(false);
 useEffect(()=>{onHistoryChange?.(historyOpen);},[historyOpen,onHistoryChange]);
 const [previewHost,setPreviewHost]=useState<HTMLDivElement|null>(null),[previewActive,setPreviewActive]=useState(false);
 const [conditionsHost,setConditionsHost]=useState<HTMLDivElement|null>(null),[calculationError,setCalculationError]=useState('');
 const previewHostValue=useMemo(()=>({element:previewHost,setActive:setPreviewActive,conditionsElement:conditionsHost,setConditionsElement:setConditionsHost,calculationError,setCalculationError}),[previewHost,conditionsHost,calculationError]);
 const [calculationReady,setCalculationReady]=useState(false);
 const [stageTimes,setStageTimes]=useState<SlaStageTiming[]>([]),[comparison,setComparison]=useState<SlaAdjustmentComparison|null>(null);
 const filterChanged=useCallback((stage:number,query:string)=>setFilter({stage,query}),[]);
 const calculation=useRef<SlaCalculationHandle>(null),historyBridge=useRef<SlaHistoryEditorBridge|null>(null);
 const registerHistoryBridge=useCallback((value:SlaHistoryEditorBridge)=>{historyBridge.current=value;},[]);
 const [historyPending,setHistoryPending]=useState(false);
 const historyBlocked=unifiedWriting||developmentWriting||Boolean(unified?.resultUnknown||development?.resultUnknown||unified?.draftResultUnknown||development?.draftResultUnknown);
 const returnFromCopy=()=>{setHistoryOpen(false);setTab('standard');};
 const recheck=(group:'unified'|'development')=>{if(!calculation.current)throw Error('本次演算入口尚未就绪');return calculation.current.recheck(group);};
 return <SlaAdjustmentPreviewHost.Provider value={previewHostValue}><div className="sla-settings-workspace"><div className="sla-adjustment-preview-host" ref={setPreviewHost} hidden={!previewActive}/><div className="sla-settings-live-content" hidden={previewActive||historyOpen}><nav className="sla-workspace-tabs" aria-label="生产管理设置分类"><div role="tablist" aria-label="设置类别">{([['standard','标准时效'],['reminders','提醒设置'],['development','开发周期']] as const).map(([key,label])=><button type="button" role="tab" key={key} id={'sla-tab-'+key} aria-selected={tab===key} aria-controls="sla-settings-content" tabIndex={tab===key?0:-1} onKeyDown={event=>{const keys:SlaSettingsTab[]=['standard','reminders','development'],index=keys.indexOf(key),next=event.key==='ArrowRight'?keys[(index+1)%3]:event.key==='ArrowLeft'?keys[(index+2)%3]:event.key==='Home'?keys[0]:event.key==='End'?keys[2]:undefined;if(next){event.preventDefault();setTab(next);document.getElementById('sla-tab-'+next)?.focus();}}} onClick={()=>setTab(key)}>{label}</button>)}</div><button type="button" className="journey-text-action" disabled={historyBlocked} onClick={()=>setHistoryOpen(true)}>查看历史设置</button></nav><SlaCalculationPreviewPanel onReadinessChange={setCalculationReady} blocked={unifiedWriting||developmentWriting||Boolean(unified?.resultUnknown||development?.resultUnknown||unified?.draftResultUnknown||development?.draftResultUnknown)} ref={calculation} ready={unifiedSettled&&developmentSettled} unified={unified} development={development} onSummary={setSummary} onStageTimes={setStageTimes} onComparison={setComparison} onAuthorityChanged={onAuthorityChanged}/><div role="tabpanel" className="sla-tab-panel" id="sla-settings-content" aria-labelledby={'sla-tab-'+tab}><SlaStandardEditor managedHistory onHistoryBridge={registerHistoryBridge} calculationReady={calculationReady} onWritePendingChange={setUnifiedWriting} externalWritePending={developmentWriting||historyPending} comparison={comparison} view={tab} onViewChange={setTab} historyOpen={historyOpen} onHistoryOpenChange={setHistoryOpen} stageTimes={stageTimes} readOnly={readOnly} onAuthorityChanged={onAuthorityChanged} onDraftSnapshot={setUnified} onInitialReadSettled={()=>setUnifiedSettled(true)} onFilterChange={filterChanged} beforePreview={()=>recheck('unified')} calculationSummary={summary}/><div hidden={tab!=='development'}><DevelopmentCycleSettings calculationReady={calculationReady} onWritePendingChange={setDevelopmentWriting} externalWritePending={unifiedWriting||historyPending} warningEnabled={unified?.values.warning_ratio?.kind==='ratio'&&!unified.errors.warning_ratio?unified.values.warning_ratio.notificationEnabled!==false:null} warningPercent={unified?.values.warning_ratio?.kind==='ratio'&&!unified.errors.warning_ratio?unified.values.warning_ratio.percent:null} comparison={comparison} expanded search={tab==='development'?'':filter.query} readOnly={readOnly} onAuthorityChanged={onAuthorityChanged} onDraftSnapshot={setDevelopment} onInitialReadSettled={()=>setDevelopmentSettled(true)} beforePreview={()=>recheck('development')} calculationSummary={summary}/></div></div>{customerControl&&<details className="cockpit-settings-node-section sla-linked-settings"><summary>客户跟单配置</summary>{customerControl}</details>}</div><SlaHistoryWorkspace visible={historyOpen} readOnly={readOnly} blocked={historyBlocked} bridge={()=>historyBridge.current} onBack={()=>setHistoryOpen(false)} onCopied={returnFromCopy} onPendingChange={setHistoryPending} onAuthorityChanged={onAuthorityChanged}/></div></SlaAdjustmentPreviewHost.Provider>;
}
export function SlaSettingsWorkspace({readOnly=false,customerControl,onAuthorityChanged=noAuthorityChange,onHistoryChange}:{onHistoryChange?(open:boolean):void;customerControl?:ReactNode;readOnly?:boolean;onAuthorityChanged?():void}){
 const [identity,setIdentity]=useState(sessionCacheVersion);
 useEffect(()=>registerSessionInvalidator(()=>setIdentity(sessionCacheVersion())),[]);
 return <SettingsDrafts {...(onHistoryChange?{onHistoryChange}:{})} customerControl={customerControl} key={identity} readOnly={readOnly} onAuthorityChanged={onAuthorityChanged}/>;
}
