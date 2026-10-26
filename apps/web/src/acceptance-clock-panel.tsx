import {createClientRequestId} from './client-request-id.js';
import {confirmInApp} from './system-dialog.js';
import {observeAcceptanceTime} from './acceptance-business-time.js';
import {verifySession} from './auth.js';
import {useCallback,useEffect,useRef,useState} from 'react';
import {Button} from '@dx-rework/ui';
import type {AcceptanceClockView} from '@dx-rework/contracts/acceptance-clock';
import {createWebUrls} from '../url-contract.js';
import './acceptance-clock-panel.css';
const urls=createWebUrls(import.meta.env.BASE_URL);
async function clockRequest<T>(path:string,body?:unknown):Promise<T>{
 const response=await fetch(urls.apiUrl(`acceptance/clock/${path}`),{credentials:'include',cache:'no-store',...(body===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})});
 const value=await response.json().catch(()=>null);
 if(!response.ok)throw new Error(value?.error?.message??'测试时钟暂时不可用，请刷新验收身份后重试');
 return value as T;
}
type Target={id:string;label:string;dueAt:string;warningAt:string|null;exclusive:boolean};
type Preview={at:string;token:string;label:string;version:number;exclusive:boolean};
const format=(at:string)=>new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date(at));
/** Hidden unless the guarded server identifies this exact resource as a test scene. */
export function AcceptanceClockPanel({resourceId}:{resourceId:string}){
 const [scene,setScene]=useState<AcceptanceClockView|null>(null),[open,setOpen]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState('');
 const [targets,setTargets]=useState<Target[]>([]),[target,setTarget]=useState(''),[boundary,setBoundary]=useState('warning'),[future,setFuture]=useState(''),[preview,setPreview]=useState<Preview|null>(null);
 const [standards,setStandards]=useState<{id:string;version:number}[]>([]),[standard,setStandard]=useState('');
 const [canStandard,setCanStandard]=useState(false);
 useEffect(()=>{let live=true;void verifySession().then(session=>{if(live&&session!=='denied')setCanStandard(Boolean(session.user.isRoot||session.user.businessRoles?.some(r=>['owner_group','production_management'].includes(r))));}).catch(()=>{});return()=>{live=false;};},[]);
 const refresh=useCallback(async()=>{const read=await clockRequest<{scene:AcceptanceClockView|null}>(`resource/${resourceId}`);setScene(read.scene);observeAcceptanceTime(resourceId,read.scene?.now??null);if(read.scene)window.dispatchEvent(new CustomEvent('acceptance-clock-changed',{detail:{scenarioId:read.scene.scenarioId,now:read.scene.now}}));},[resourceId]);
 useEffect(()=>{let live=true;void clockRequest<{scene:AcceptanceClockView|null}>(`resource/${resourceId}`).then(r=>{if(live){setScene(r.scene);observeAcceptanceTime(resourceId,r.scene?.now??null);}}).catch(()=>{if(live)setScene(null);});return()=>{live=false;observeAcceptanceTime(resourceId,null);};},[resourceId]);
 const loadTargets=async()=>{if(!scene)return;try{setTargets(await clockRequest<Target[]>(`scenarios/${scene.scenarioId}/targets`));setStandards(await clockRequest<{id:string;version:number}[]>('standards'));}catch(reason){setError((reason as Error).message);}};
 const action=async(work:()=>Promise<void>)=>{if(busy)return;setBusy(true);setError('');setMessage('');try{await work();}catch(reason){setError((reason as Error).message);setPreview(null);await refresh().catch(()=>{});}finally{setBusy(false);}};
 const advance=async(at:string,token?:string)=>{if(!scene)return;await action(async()=>{
  const result=await clockRequest<{scene:AcceptanceClockView;scan:{status:string}}>(`scenarios/${scene.scenarioId}/advance`,{expectedVersion:scene.version,requestKey:createClientRequestId(),at,...(token?{previewToken:token}:{})});
  setScene(result.scene);observeAcceptanceTime(resourceId,result.scene.now);setPreview(null);setMessage(result.scan.status==='completed'?'时间已推进，提醒扫描已完成。业务未自动完成，当前填写内容保留。':'时间已保存，提醒扫描未完成，请重新扫描；当前业务输入保留。');
  window.dispatchEvent(new CustomEvent('acceptance-clock-changed',{detail:{scenarioId:scene.scenarioId,now:result.scene.now}}));
  await loadTargets();
 });};
 if(!scene)return null;
 return <details className="acceptance-clock" open={open} onToggle={event=>{setOpen(event.currentTarget.open);if(event.currentTarget.open)void loadTargets();}}>
  <summary><strong>测试时间</strong><span>{format(scene.now)} · 北京时间</span></summary>
  <div className="acceptance-clock__body">
   <p className="acceptance-clock__note">仅本隔离场景 · {scene.name} · 正常办理权限及前置条件保持不变</p>
   <fieldset disabled={busy}><legend className="sr-only">测试时钟操作</legend>
    <div className="acceptance-clock__row">{[[30,'前进30分钟'],[120,'前进2小时'],[1440,'前进1天']].map(([minutes,label])=><Button key={minutes} variant="secondary" onClick={()=>void advance(new Date(Date.parse(scene.now)+Number(minutes)*60000).toISOString())}>{label}</Button>)}<Button variant="secondary" onClick={()=>void action(async()=>{await clockRequest(`scenarios/${scene.scenarioId}/scan`,{requestKey:createClientRequestId()});await refresh();setMessage('本场景提醒扫描完成；重复扫描不会重复创建提醒。');})}>重新扫描提醒</Button></div>
    <div className="acceptance-clock__row"><label>指定未来时刻<input type="datetime-local" value={future} onChange={e=>{setFuture(e.target.value);setPreview(null);}}/></label><Button variant="secondary" disabled={!future} onClick={()=>{if(future)void advance(new Date(`${future}+08:00`).toISOString());}}>推进到此刻</Button><small>北京时间，只允许前进</small></div>
    <div className="acceptance-clock__row"><label>跳转节点<select value={target} onChange={e=>{setTarget(e.target.value);setPreview(null);}}><option value="">选择有时限的节点</option>{targets.map(t=><option key={t.id} value={t.id}>{t.label}</option>)}</select></label><label>边界<select value={boundary} onChange={e=>{setBoundary(e.target.value);setPreview(null);}}>{[['warning_before','临期前1毫秒'],['warning','临期'],['due_before','到期前1毫秒'],['due','到期'],['due_after','到期后1毫秒']].map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label><Button variant="secondary" disabled={!target} onClick={()=>void action(async()=>setPreview(await clockRequest<Preview>(`scenarios/${scene.scenarioId}/preview`,{nodeId:target,boundary})))}>查看跳转结果</Button></div>
    {preview&&<div className="acceptance-clock__preview"><span>{preview.label} → {format(preview.at)}.{new Date(preview.at).getUTCMilliseconds().toString().padStart(3,'0')}{preview.exclusive?' · 此刻已越过日期截止边界':''}</span><Button onClick={()=>void advance(preview.at,preview.token)}>确认推进</Button></div>}
   </fieldset>
   {error&&<p role="alert">{error}</p>}{message&&<p role="status">{message} <button type="button" className="acceptance-clock__link" onClick={()=>void confirmInApp('刷新将清除尚未保存的表单内容。已保存后继续？',{title:'刷新办理数据',confirmLabel:'已保存，刷新'}).then(confirmed=>{if(confirmed)window.location.reload();})}>刷新办理数据</button></p>}
   {scene.lastScan?.status==='failed'&&<p role="alert">上次扫描未完成，请重新扫描；时间及业务记录已保留。</p>}
   <details><summary>测试标准与扫描结果</summary><p>当前标准 v{scene.configurationVersion}。只影响之后新建的测试业务输入，已有冻结标准及历史不变。</p>{canStandard&&<div className="acceptance-clock__row"><label>既有已发布标准<select value={standard} onChange={e=>setStandard(e.target.value)}><option value="">选择版本</option>{standards.map(s=><option key={s.id} value={s.id}>标准 v{s.version}</option>)}</select></label><Button variant="secondary" disabled={busy||!standard} onClick={()=>void action(async()=>{const result=await clockRequest<{scene:AcceptanceClockView}>(`scenarios/${scene.scenarioId}/standard`,{expectedVersion:scene.version,requestKey:createClientRequestId(),configurationId:standard});setScene(result.scene);setPreview(null);setMessage('场景后续新输入使用已选版本，现有订单标准未改。');})}>选为后续测试标准</Button></div>}<p>最近扫描：{scene.lastScan?.status??'尚未执行'}</p></details>
   <small>重测请在验收中心复制新场景。复制只带业务输入，不带已完成事实。</small>
  </div>
 </details>;
}
export function AcceptanceClockLauncher(){
 const [scenes,setScenes]=useState<AcceptanceClockView[]>([]),[name,setName]=useState(''),[copy,setCopy]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const creationAttempt=useRef<{payload:string;key:string}|null>(null);
 useEffect(()=>{void clockRequest<{scenarios:AcceptanceClockView[]}>('scenarios').then(r=>setScenes(r.scenarios)).catch(()=>{});},[]);
 return <details className="acceptance-clock"><summary><strong>SLA测试场景</strong><span>新建或复制隔离业务输入</span></summary><div className="acceptance-clock__body"><p>先切换原UAT业务身份，再创建测试开发来源；后续沿原业务页面办理。</p><form onSubmit={event=>{event.preventDefault();if(busy)return;setBusy(true);setError('');const payload=JSON.stringify({name,copy});if(creationAttempt.current?.payload!==payload)creationAttempt.current={payload,key:createClientRequestId()};void clockRequest<AcceptanceClockView>('scenarios',{name,requestKey:creationAttempt.current.key,...(copy?{copyScenarioId:copy}:{})}).then(scene=>{window.location.assign(`${urls.pageUrl('ui/digital-production')}?development=${scene.sourceIds[0]}`);}).catch(reason=>setError(reason.message)).finally(()=>setBusy(false));}}><fieldset disabled={busy} className="acceptance-clock__row"><label>场景名称<input required maxLength={80} value={name} onChange={e=>setName(e.target.value)}/></label><label>业务输入<select value={copy} onChange={e=>setCopy(e.target.value)}><option value="">空白新场景</option>{scenes.map(s=><option key={s.scenarioId} value={s.scenarioId}>{s.name}</option>)}</select></label><Button type="submit">创建并打开</Button></fieldset></form>{error&&<p role="alert">{error}</p>}{scenes.length>0&&<ul>{scenes.slice(0,10).map(s=><li key={s.scenarioId}><a href={`${urls.pageUrl('ui/digital-production')}?development=${s.sourceIds[0]}`}>{s.name}</a> · {format(s.now)}</li>)}</ul>}</div></details>;
}
