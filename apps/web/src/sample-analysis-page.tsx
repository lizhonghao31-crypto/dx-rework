import {canReadSampleAnalysis,analysisDraftQuery,analysisNavigation,initialAnalysisNavigation} from './sample-analysis-model.js';
import { useEffect,useState,useReducer } from 'react';
import { SampleAnalysisResponseSchema,SampleAmountsSchema,type SampleAnalysisQuery,type SampleAnalysisResponse,type SampleAmounts } from '@dx-rework/contracts';
import type { z } from 'zod';
import { Header,Shell } from './components.js';
import { verifySession } from './auth.js';
import { createWebUrls } from '../url-contract.js';
import { SampleAnalysisView } from './sample-analysis-view.js';
import './rework-v2-form.css';
import './sample-workspace.css';
const {apiUrl,pageUrl}=createWebUrls(import.meta.env.BASE_URL);
class AnalysisReadError extends Error{constructor(message:string,readonly denied:boolean){super(message);}}
async function read<T>(path:string,schema:z.ZodType<T>,signal:AbortSignal){const response=await fetch(apiUrl('samples'+path),{credentials:'include',cache:'no-store',signal});const body=await response.json();if(!response.ok)throw new AnalysisReadError(body?.error?.message??'样衣分析读取失败，请重试',response.status===401||response.status===403);return schema.parse(body);}
export function SampleAnalysisPage(){
 const [access,setAccess]=useState<'loading'|'allowed'|'denied'>('loading'),[data,setData]=useState<SampleAnalysisResponse|null>(null),[legacy,setLegacy]=useState<SampleAmounts|null>(null);
 const [{query,draft,history},navigate]=useReducer(analysisNavigation,undefined,initialAnalysisNavigation);
 const [retry,setRetry]=useState(0),[busy,setBusy]=useState(true),[error,setError]=useState('');
 useEffect(()=>{let current=true;void verifySession().then(session=>{if(current)setAccess(session!=='denied'&&session.status==='authorized'&&canReadSampleAnalysis(session.user)?'allowed':'denied');}).catch(()=>{if(current){setAccess('denied');setError('身份核验失败，请重新进入页面。');}});return()=>{current=false;};},[]);
 useEffect(()=>{
  if(access!=='allowed')return;const abort=new AbortController();setBusy(true);setError('');const params=new URLSearchParams();for(const [key,value] of Object.entries(query))if(value!==undefined)params.set(key,String(value));
  void Promise.all([read('/analysis?'+params,SampleAnalysisResponseSchema,abort.signal),read('/amounts',SampleAmountsSchema,abort.signal)]).then(([next,old])=>{if(!abort.signal.aborted){setData(next);setLegacy(old);}}).catch(e=>{if(abort.signal.aborted)return;if(e instanceof AnalysisReadError&&e.denied){setData(null);setLegacy(null);setAccess('denied');}setError(e instanceof Error?e.message:'样衣分析读取失败');}).finally(()=>{if(!abort.signal.aborted)setBusy(false);});return()=>abort.abort();
 },[query,retry,access]);
 const apply=()=>{const result=analysisDraftQuery(draft,query.group);if(!result.success){setError('请检查日期范围、单价和筛选选择。');return;}navigate({type:'apply',query:result.data});};
 const change=(patch:Partial<SampleAnalysisQuery>)=>navigate({type:'change',patch,baseQuery:data?.filters??query});
 const drill=(patch:Partial<SampleAnalysisQuery>)=>{if(!busy)navigate({type:'drill',patch,baseQuery:data?.filters??query});};
 return <Shell active="库存金额管理"><div className="rework-v2-page sample-workspace sample-analysis-workspace"><Header title="库存金额管理" subtitle="按采购、当前持有和处置事实查阅样衣。" badge="样衣管理"/>
  {access==='loading'?<p role="status">正在核验查看权限…</p>:access==='denied'?<p role="alert">{error||'当前身份无权查看样衣金额分析。'}</p>:<SampleAnalysisView data={data} legacy={legacy} busy={busy} error={error} draft={draft} onDraft={(key,value)=>navigate({type:'draft',key,value})} onApply={apply} onReset={()=>navigate({type:'reset'})} onQuery={change} onDrill={drill} canGoBack={history.length>0} onBack={()=>{if(!busy)navigate({type:'back'});}} onRefresh={()=>setRetry(value=>value+1)} detailUrl={id=>pageUrl('ui/samples/'+id)}/>}
 </div></Shell>;
}

