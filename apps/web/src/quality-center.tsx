import {Button} from '@astryxdesign/core/Button';
import {useState} from 'react';
import type {QualityNativeTaskQuery} from '@dx-rework/contracts/production-readiness';
import {designerAstryxCss} from './designer-astryx.js';
import {NativeAssignedTaskTable} from './warehouse-native-task-table.js';
import {qualityWorkbenchPath,readQualityWorkbenchRoute} from './quality-workbench-route.js';

const labels={craft:'二次工艺回仓检查',factory:'加工检查'} as const;
export function QualityCenter({search}:{search:string}){
 const [route,setRoute]=useState(()=>readQualityWorkbenchRoute(new URLSearchParams(search)));
 if(!route)return <p role="alert">质量中心筛选不正确，请从原入口重新进入。</p>;
 const base=import.meta.env.BASE_URL;
 const update=(value:QualityNativeTaskQuery)=>{
  const next={workspace:'quality' as const,...value};
  window.history.replaceState(window.history.state,'',qualityWorkbenchPath(next,base));
  setRoute(next);
 };
 return <div className="dx-designer-astryx" lang="zh-CN">
  <style>{designerAstryxCss}</style>
  <h1>质量中心</h1>
  <section aria-label="质量任务类别" className="pattern-actions">
   {(['craft','factory'] as const).map(kind=><Button key={kind} type="button" label={labels[kind]} aria-pressed={route.kind===kind}
    variant={route.kind===kind?'primary':'secondary'} onClick={()=>update({...route,kind,page:1})}/>)}
  </section>
  <NativeAssignedTaskTable<QualityNativeTaskQuery> key={route.kind} initial={route} onFilter={update} area="quality"
   returnTo={qualityWorkbenchPath(route,base)}/>
 </div>;
}
