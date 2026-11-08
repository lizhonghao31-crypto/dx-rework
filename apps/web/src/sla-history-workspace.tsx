import {useEffect,useRef,useState} from 'react';
import {Button} from '@dx-rework/ui';
import {DIGITAL_SLA_PARAMETERS,type DigitalSlaValue} from '@dx-rework/contracts/digital-sla';
import type {SlaCopyVersion,SlaHistoryPage,SlaVersionDetail} from '@dx-rework/contracts/sla-settings-history';
import {SlaDraftEnvelopeSchema,SlaDraftSavedReplySchema,type SlaDraftEnvelope} from '@dx-rework/contracts/sla-settings-drafts';
import {digitalRequest,DigitalRequestError} from './digital-production-api.js';
import {useDigitalDetailNavigationGuard} from './use-digital-detail-navigation-guard.js';
import {createClientRequestId} from './client-request-id.js';
import {readableSlaValue} from './sla-settings-draft.js';
import {SlaOrderApplicationPanel} from './sla-order-application-panel.js';
import type {SlaHistoryEditorBridge} from './sla-standard-editor.js';
const publicationDate=(value:string)=>new Date(value).toLocaleDateString('zh-CN',{timeZone:'Asia/Shanghai'});
const valueLabel=(value:DigitalSlaValue)=>readableSlaValue(value)+('notificationEnabled'in value&&value.notificationEnabled===false?' · 提醒关闭':'');
export function SlaHistoryWorkspace({visible,readOnly,blocked,bridge,onBack,onCopied,onPendingChange,onAuthorityChanged}:{visible:boolean;readOnly:boolean;blocked:boolean;bridge():SlaHistoryEditorBridge|null;onBack():void;onCopied():void;onPendingChange(pending:boolean):void;onAuthorityChanged():void}){
 const [tab,setTab]=useState<'history'|'application'>('history'),[page,setPage]=useState<SlaHistoryPage|null>(null),[cursors,setCursors]=useState<(number|null)[]>([null]),[index,setIndex]=useState(0),[head,setHead]=useState<SlaDraftEnvelope|null>(null);
 const [selected,setSelected]=useState<number|null>(null),[detail,setDetail]=useState<SlaVersionDetail|null>(null),[loading,setLoading]=useState(false),[detailLoading,setDetailLoading]=useState(false),[error,setError]=useState(''),[detailError,setDetailError]=useState(''),[notice,setNotice]=useState('');
 const [copyBusy,setCopyBusy]=useState(false),[copyPending,setCopyPending]=useState(false),[copied,setCopied]=useState(false),[applicationPending,setApplicationPending]=useState(false),[parameterKeys,setParameterKeys]=useState<string[]>([]);
 const command=useRef<{body:SlaCopyVersion;key:string}|null>(null),reading=useRef(0),detailReading=useRef(0),copying=useRef(false),live=useRef(true),scroll=useRef(0);
 useEffect(()=>{live.current=true;return()=>{live.current=false;reading.current++;detailReading.current++;};},[]);
 const authority=(error:unknown)=>{if(error instanceof DigitalRequestError&&[401,403].includes(error.status??0)){setPage(null);setHead(null);setDetail(null);onAuthorityChanged();}};
 const read=async(nextIndex=index,before=cursors[nextIndex]??null)=>{
  const generation=++reading.current;setLoading(true);setError('');
  try{const [result,own]=await Promise.all([digitalRequest<SlaHistoryPage>(`sla-settings/history?pageSize=5${before===null?'':`&beforeVersion=${before}`}`),readOnly?Promise.resolve(null):digitalRequest('sla-settings/drafts?group=unified').then(value=>SlaDraftEnvelopeSchema.parse(value))]);
   if(!Array.isArray(result.items)||!Number.isInteger(result.currentVersion)||!Number.isInteger(result.total))throw Error('历史返回不完整，请重新读取');
   if(own&&own.currentStandardVersion!==result.currentVersion)throw Error('读取期间现行标准已更新，请重新读取');
   if(live.current&&generation===reading.current){setPage(result);setHead(own);setIndex(nextIndex);}
  }catch(error){if(live.current&&generation===reading.current){setError((error as Error).message);authority(error);}}
  finally{if(live.current&&generation===reading.current)setLoading(false);}
 };
 const view=async(version:number)=>{const generation=++detailReading.current;setSelected(version);setDetail(null);setDetailLoading(true);setDetailError('');try{const result=await digitalRequest<SlaVersionDetail>(`sla-settings/history/${version}`);if(result.version!==version||!Array.isArray(result.differences))throw Error('版本返回不完整');if(live.current&&generation===detailReading.current)setDetail(result);}catch(error){if(live.current&&generation===detailReading.current){setDetailError((error as Error).message);authority(error);}}finally{if(live.current&&generation===detailReading.current)setDetailLoading(false);}};
 useEffect(()=>{if(visible){void read();if(selected!==null)void view(selected);requestAnimationFrame(()=>window.scrollTo({top:scroll.current}));}},[visible]);
 const pending=copyBusy||copyPending||copied||applicationPending;
 useDigitalDetailNavigationGuard(pending,pending,copying,'复制或应用结果尚未确认，仍要离开？');
 useEffect(()=>{onPendingChange(pending);return()=>onPendingChange(false);},[pending,onPendingChange]);
 const restoreCopy=async()=>{const editor=bridge();if(!editor)throw Error('统一标准编辑器尚未就绪');await editor.reloadCopy();if(live.current){setCopied(false);setCopyPending(false);setNotice('已读取当前个人草稿，尚未发布。');onCopied();}};
 const copy=async(version:number)=>{
  if(copying.current||readOnly||blocked||applicationPending)return;
  copying.current=true;setCopyBusy(true);setError('');setNotice('');
  try{
   if(copied){await restoreCopy();return;}
   if(!command.current){if(!page||!head||loading||error)throw Error('请先重新读取现行标准及你的草稿');const editor=bridge();if(!editor)throw Error('统一标准编辑器尚未就绪');if(!await editor.confirmReplace())return;command.current={body:{sourceVersion:version,expectedVersion:page.currentVersion,expectedDraftRevision:head.revision},key:createClientRequestId()};}
   const exact=command.current;let reply;
   try{reply=SlaDraftSavedReplySchema.parse(await digitalRequest('sla-settings/drafts/copy-version','POST',exact.body,exact.key));if(reply.saved.group!=='unified'||reply.saved.sourceVersion!==exact.body.sourceVersion)throw Error('来源版本不一致');}catch(error){if(!(error instanceof DigitalRequestError))throw new DigitalRequestError('复制回执尚未确认，请用原命令确认',null);throw error;}
   command.current=null;setCopyPending(false);setCopied(true);
   if(reply.superseded)setNotice('原复制已成功，另一窗口随后修改了草稿；将读取当前个人草稿。');
   try{await restoreCopy();}catch(error){setError('草稿已复制，读取当前草稿失败。请重新读取，不要再次复制。'+(error as Error).message);}
  }catch(error){if(live.current){authority(error);setError((error as Error).message);if(command.current&&(!(error instanceof DigitalRequestError)||error.resultUnknown))setCopyPending(true);else{command.current=null;setCopyPending(false);if(error instanceof DigitalRequestError&&error.status===409){void read();setNotice('原编辑仍保留。现行标准或个人草稿已变化，重新核对后再复制。');}}}}
  finally{copying.current=false;if(live.current)setCopyBusy(false);}
 };
 const locked=blocked||pending,copyDisabled=readOnly||blocked||applicationPending||copyBusy||loading||!head||Boolean(error)&&!copyPending&&!copied;
 return <section className="sla-history-workspace" hidden={!visible} aria-label="历史版本与应用范围">
  <header className="sla-history-heading"><Button variant="secondary" disabled={pending} onClick={()=>{scroll.current=window.scrollY;onBack();}}>← 返回设置</Button><h2>历史版本与应用范围</h2></header>
  <nav className="sla-workspace-tabs" aria-label="历史设置分类"><div role="tablist" aria-label="历史设置类别">{([['history','历史标准'],['application','应用到进行中订单']] as const).map(([key,label])=><button type="button" role="tab" aria-selected={tab===key} key={key} disabled={pending} onClick={()=>setTab(key)}>{label}</button>)}</div><Button variant="secondary" disabled={locked||loading} onClick={()=>void read()}>刷新</Button></nav>
  {error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
  {(copyPending||copied)&&<Button disabled={copyBusy} onClick={()=>void copy(command.current?.body.sourceVersion??selected??0)}>{copied?'重新读取已复制草稿':'用原命令确认复制结果'}</Button>}
  <div hidden={tab!=='history'} className="sla-history-grid"><div className="sla-history-main"><div className="sla-history-summary cockpit-settings-node-section"><span>{loading?'核对中：':error?'上次读取：':'当前使用：'}<strong>{page?.currentVersion?`统一标准 v${page.currentVersion}`:loading?'读取中…':page?'尚无已发布标准':'未读取'}</strong></span><span>历史版本：<strong>{page?`共 ${page.total} 个`:'—'}</strong></span><span>{readOnly?'历史标准只读':'可复制为草稿并调整'}</span></div>
   <section className="sla-history-table-card cockpit-settings-node-section" aria-label="已发布历史标准"><div className="sla-history-table-scroll" tabIndex={0}><table><thead><tr><th>版本</th><th>发布日期</th><th>变更摘要</th><th>使用范围</th><th>操作</th></tr></thead><tbody>{page?.items.map(row=><tr key={row.version} aria-selected={selected===row.version}><th scope="row">v{row.version}{row.version===page.currentVersion&&<small className="sla-history-current">当前使用</small>}</th><td>{publicationDate(row.publishedAt)}</td><td><span className="sla-history-reason" title={row.reason}>{row.reason}</span></td><td>{row.version===page.currentVersion?'新订单默认':'原采用保留'}</td><td><button type="button" className="journey-text-action" aria-label={`查看版本 v${row.version}`} disabled={locked} onClick={()=>void view(row.version)}>查看</button>{!readOnly&&<button type="button" className="journey-text-action" aria-label={`复制 v${row.version} 为草稿`} disabled={copyDisabled} onClick={()=>void copy(row.version)}>复制为草稿</button>}</td></tr>)}</tbody></table></div>
    {loading&&<p role="status">正在读取历史标准…</p>}{page&&!page.items.length&&!loading&&<p>此页没有已发布标准。</p>}
    <div className="sla-history-pagination"><Button variant="secondary" disabled={locked||loading||index===0} onClick={()=>void read(index-1)}>上一页</Button><span>第 {index+1} 页 · 共 {page?.total??'—'} 个版本</span><Button variant="secondary" disabled={locked||loading||page?.nextBeforeVersion==null} onClick={()=>{if(page?.nextBeforeVersion!=null){const next=page.nextBeforeVersion;setCursors(values=>[...values.slice(0,index+1),next]);void read(index+1,next);}}}>下一页</Button></div>
   </section></div>
   <aside className="sla-history-detail cockpit-settings-node-section" aria-label="查看历史版本"><header><h3>{selected?`查看版本 v${selected}`:'查看历史版本'}</h3>{selected!==null&&<button type="button" aria-label="关闭版本详情" className="journey-text-action" disabled={locked} onClick={()=>{detailReading.current++;setSelected(null);setDetail(null);setDetailError('');setDetailLoading(false);}}>×</button>}</header>
    {detailLoading?<p role="status">正在读取此版本…</p>:detailError?<><p role="alert">{detailError}</p><Button variant="secondary" disabled={locked} onClick={()=>selected&&void view(selected)}>重试读取版本</Button></>:detail?<><p className="sla-history-difference-count">与当前 v{detail.currentVersion} 相比：<strong>{detail.differences.length} 项不同</strong></p><dl className="sla-history-differences">{detail.differences.map(change=><div key={change.key}><dt>{change.label}</dt><dd><strong>{valueLabel(change.historical)}</strong><small>当前：{valueLabel(change.current)}</small></dd></div>)}</dl>{!detail.differences.length&&<p>有效标准值一致。</p>}<details><summary>此版本全部标准</summary><dl className="sla-history-differences">{DIGITAL_SLA_PARAMETERS.map(parameter=><div key={parameter.key}><dt>{parameter.label}</dt><dd>{valueLabel(detail.values[parameter.key]!)}</dd></div>)}</dl></details><dl className="sla-history-source"><div><dt>发布时间</dt><dd>{publicationDate(detail.publishedAt)}</dd></div><div><dt>发布人</dt><dd>{detail.publishedBy??'未记录'}</dd></div><div><dt>原因</dt><dd>{detail.reason}</dd></div></dl>{!readOnly&&<Button variant="secondary" disabled={copyDisabled} onClick={()=>void copy(detail.version)}>复制此版本为草稿</Button>}<p className="sla-history-note">历史订单的实际时间不改变</p></>:<p>选择左侧版本，查看与当前标准的差异。</p>}
   </aside></div>
  <div hidden={tab!=='application'} className="sla-history-application cockpit-settings-node-section"><h3>应用现行标准 {page?.currentVersion?`v${page.currentVersion}`:''}</h3>{readOnly?<p>当前岗位可查看历史标准，无权应用在途订单。</p>:<><p>主动选择调整项及订单，预览后再确认；已完成和原冻结事实保留。</p><details className="sla-history-parameters"><summary>选择调整项（{parameterKeys.length} 项）</summary><div>{DIGITAL_SLA_PARAMETERS.filter(parameter=>!['unlimited','order_date'].includes(parameter.defaultValue.kind)).map(parameter=><label key={parameter.key}><input type="checkbox" checked={parameterKeys.includes(parameter.key)} disabled={locked} onChange={event=>setParameterKeys(keys=>event.target.checked?[...keys,parameter.key]:keys.filter(key=>key!==parameter.key))}/>{parameter.label}</label>)}</div></details>{page&&<SlaOrderApplicationPanel expanded managedCandidates version={page.currentVersion} parameterKeys={parameterKeys} disabled={blocked||copyBusy||copyPending||copied||loading||Boolean(error)||page.currentVersion===0} onPendingChange={setApplicationPending}/>}</>}</div>
  {tab==='history'&&<section className="sla-history-application-cta cockpit-settings-node-section"><h3>要让新规则用于进行中的订单？</h3><Button variant="secondary" disabled={locked} onClick={()=>setTab('application')}>选择进行中订单</Button><span>先预览影响，再确认应用</span></section>}
 </section>;
}
