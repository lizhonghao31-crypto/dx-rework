import {useCallback,useEffect,useRef,useState} from 'react';
import type {DigitalSlaValues} from '@dx-rework/contracts/digital-sla';
import type {DevelopmentCycleValues} from '@dx-rework/contracts/digital-development-technical';
import {registerSessionInvalidator,sessionCacheVersion} from './auth-session.js';
import {SlaStandardEditor} from './sla-standard-editor.js';
import {DevelopmentCycleSettings} from './development-cycle-settings.js';
import {SlaCalculationPreviewPanel,type SlaCalculationHandle} from './sla-calculation-preview.js';
import type {SlaStageTiming} from './sla-calculation-preview-model.js';
import type {SlaDraftSnapshot} from './sla-settings-draft.js';

const noAuthorityChange=()=>undefined;
function SettingsDrafts({readOnly,onAuthorityChanged=noAuthorityChange}:{readOnly:boolean;onAuthorityChanged?():void}){
 const [unified,setUnified]=useState<SlaDraftSnapshot<DigitalSlaValues>|null>(null),[development,setDevelopment]=useState<SlaDraftSnapshot<DevelopmentCycleValues>|null>(null),[summary,setSummary]=useState('正在读取本次流程依据');
 const [unifiedSettled,setUnifiedSettled]=useState(false),[developmentSettled,setDevelopmentSettled]=useState(false),[filter,setFilter]=useState({stage:3,query:''});
 const [stageTimes,setStageTimes]=useState<SlaStageTiming[]>([]);
 const filterChanged=useCallback((stage:number,query:string)=>setFilter({stage,query}),[]);
 const calculation=useRef<SlaCalculationHandle>(null);
 const recheck=(group:'unified'|'development')=>{if(!calculation.current)throw Error('本次演算入口尚未就绪');return calculation.current.recheck(group);};
 return <div className="sla-settings-workspace"><SlaCalculationPreviewPanel ref={calculation} ready={unifiedSettled&&developmentSettled} unified={unified} development={development} onSummary={setSummary} onStageTimes={setStageTimes} onAuthorityChanged={onAuthorityChanged}/><SlaStandardEditor stageTimes={stageTimes} readOnly={readOnly} onAuthorityChanged={onAuthorityChanged} onDraftSnapshot={setUnified} onInitialReadSettled={()=>setUnifiedSettled(true)} onFilterChange={filterChanged} beforePreview={()=>recheck('unified')} calculationSummary={summary}/><div hidden={Boolean(unified)&&filter.stage!==2&&!filter.query}><DevelopmentCycleSettings search={filter.query} readOnly={readOnly} onAuthorityChanged={onAuthorityChanged} onDraftSnapshot={setDevelopment} onInitialReadSettled={()=>setDevelopmentSettled(true)} beforePreview={()=>recheck('development')} calculationSummary={summary}/></div></div>;
}
export function SlaSettingsWorkspace({readOnly=false,onAuthorityChanged=noAuthorityChange}:{readOnly?:boolean;onAuthorityChanged?():void}){
 const [identity,setIdentity]=useState(sessionCacheVersion);
 useEffect(()=>registerSessionInvalidator(()=>setIdentity(sessionCacheVersion())),[]);
 return <SettingsDrafts key={identity} readOnly={readOnly} onAuthorityChanged={onAuthorityChanged}/>;
}
