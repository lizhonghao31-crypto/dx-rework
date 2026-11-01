import {DevelopmentCycleSettings} from './development-cycle-settings.js';
import {SeriesSettings} from './series-settings.js';
import {useEffect,useState} from 'react';
import {PageHeader} from '@dx-rework/ui/production';
import {JOURNEY_NODES} from '@dx-rework/contracts/digital-production-journey';
import type {DigitalAccessOptions} from './digital-production-access-panel.js';
import {DigitalCockpitPersonnel} from './digital-cockpit-personnel.js';
import {digitalRequest} from './digital-production-api.js';
import {SlaStandardEditor} from './sla-standard-editor.js';
import './cockpit-production-settings.css';
export const cockpitPolicyStage=(key:string)=>JOURNEY_NODES.find(node=>node.key===(key==="bulk_cutting_external"?"bulk_cutting":key==="production_sheet"?"production_instruction":key))?.stage??"other";
export function CockpitProductionSettings(){
 const [access,setAccess]=useState<DigitalAccessOptions|null>(null),[error,setError]=useState('');
 useEffect(()=>{const controller=new AbortController();void digitalRequest<DigitalAccessOptions>('access/options','GET',undefined,undefined,{signal:controller.signal}).then(setAccess).catch(e=>{if(e.name!=='AbortError')setError(e.message);});return()=>controller.abort();},[]);
 return <div className="cockpit-settings"><PageHeader title="生产管理设置"/>
  {error&&<p role="alert">{error}</p>}
  {!access&&!error&&<p>正在读取设置…</p>}
  {access&&!access.manage&&!access.customers&&<p>当前岗位无权访问生产管理设置。</p>}
  {access?.customers&&<details className="cockpit-settings-node-section"><summary>客户默认跟单</summary><DigitalCockpitPersonnel orderId={null} onChanged={()=>undefined}/></details>}
  {access?.manage&&<><SlaStandardEditor/><DevelopmentCycleSettings/><SeriesSettings/></>}
 </div>;
}
