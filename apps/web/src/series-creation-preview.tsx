import {useEffect,useState} from 'react';
import type {SeriesMilestone,SeriesProfile} from '@dx-rework/contracts/digital-series-plan';
import {digitalRequest} from './digital-production-api.js';
import './series-plan.css';
export function SeriesCreationPreview({customerCode,salesYear,salesSeries,requiresColorMatching}:{customerCode:string;salesYear:number|null;salesSeries:string|null;requiresColorMatching:boolean|null}){
 const [result,setResult]=useState<{profile:SeriesProfile;candidateDate:string|null;basis:string;milestones:SeriesMilestone[]}|null>(null),[error,setError]=useState('');
 useEffect(()=>{setResult(null);setError('');if(!salesYear||!salesSeries)return;const controller=new AbortController();let current=true;
  const query=new URLSearchParams({customerCode,salesYear:String(salesYear),salesSeries,requiresColorMatching:requiresColorMatching===null?'':String(requiresColorMatching)});
  void digitalRequest<typeof result>(`series-candidate?${query}`,'GET',undefined,undefined,{signal:controller.signal}).then(r=>{if(!r||!Array.isArray(r.milestones))throw Error('未取得完整计划候选，请稍后重新选择系列');if(current)setResult(r);}).catch(e=>{if(current&&e.name!=='AbortError')setError(e.message);});return()=>{current=false;controller.abort();};},[customerCode,salesYear,salesSeries,requiresColorMatching]);
 if(!salesYear||!salesSeries)return null;
 return <details className="series-plan-panel"><summary>系统候选计划出货：{result?.candidateDate??'尚未生成'}<small>不会带入或覆盖客户约定出货日期</small></summary>{error&&<p role="alert">{error}</p>}{result?<><p>{result.basis==='series-suggestion'?'当前月份偏移与15日为建议参数，正式订单需有权人员确认采用。':'按已发布系列默认值计算候选，正式订单仍需确认采用。'}</p>{!result.candidateDate&&<p>本月份不含配置日号，请正式规划时明确选择有效日期；不自动跨月。</p>}<div className="series-plan-scroll"><table><thead><tr><th>节点</th><th>岗位</th><th>候选截止</th></tr></thead><tbody>{result.milestones.map(m=><tr key={m.id}><th>{m.label}</th><td>{m.role}</td><td>{m.targetDate}</td></tr>)}</tbody></table></div>{requiresColorMatching===null&&<p>待设计明确辅料是否需对色后显示A/B节点候选。</p>}</>:!error&&<p>正在计算候选…</p>}</details>;
}
