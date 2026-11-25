import {Button} from '@astryxdesign/core/Button';
import {useState} from 'react';
import {designerAstryxCss} from './designer-astryx.js';
import {QualityDirectoryTable} from './quality-directory-table.js';
import {qualityWorkbenchPath,readQualityWorkbenchRoute,type QualityWorkbenchRoute} from './quality-workbench-route.js';

const labels={craft:'二次工艺回仓检查',factory:'加工检查'} as const;
export function QualityCenter({search}:{search:string}){
 const [route,setRoute]=useState(()=>readQualityWorkbenchRoute(new URLSearchParams(search)));
 if(!route)return <p role="alert">质量中心筛选不正确，请从原入口重新进入。</p>;
 const base=import.meta.env.BASE_URL;
 const update=(value:QualityWorkbenchRoute)=>{
  window.history.replaceState(window.history.state,'',qualityWorkbenchPath(value,base));
  setRoute(value);
 };
 return <div className="dx-designer-astryx" lang="zh-CN">
  <style>{designerAstryxCss}</style>
  <h1>质量中心</h1>
  <section aria-label="质量任务类别" className="pattern-actions">
   {(['craft','factory'] as const).map(kind=><Button key={kind} type="button" label={labels[kind]} aria-pressed={(route.kind==='craft')===(kind==='craft')}
    variant={(route.kind==='craft')===(kind==='craft')?'primary':'secondary'} onClick={()=>{if((route.kind==='craft')!==(kind==='craft'))update({...route,kind,page:1});}}/>)}
  </section>
  <QualityDirectoryTable key={route.kind} route={route} update={update}/>
 </div>;
}
