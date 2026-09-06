import {useEffect,useRef,useState} from 'react';
import {z} from 'zod';
import {SampleWorkflowViewSchema,SampleWorkflowResultSchema,SampleHandoffQrSchema,SampleHandoffLookupSchema,SampleBatchReturnResultSchema,type SampleView} from '@dx-rework/contracts';
import {Button,Surface} from '@dx-rework/ui';
import {Shell,Header} from './components.js';
import {SampleImageUpload,SamplePersonPicker} from './sample-create-page.js';
import {createClientRequestId} from './client-request-id.js';
import {createWebUrls} from '../url-contract.js';
import {verifySession} from './auth.js';
import './rework-v2-form.css';
const {apiUrl,pageUrl}=createWebUrls(import.meta.env.BASE_URL);
async function read<T>(path:string,schema:z.ZodType<T>,init:RequestInit={}):Promise<T>{
 const response=await fetch(apiUrl(path),{...init,credentials:'include',cache:'no-store',headers:{'content-type':'application/json',...init.headers}}),body=await response.json();
 if(!response.ok)throw new Error(body?.error?.message??'操作失败，请重试');return schema.parse(body);
}
function useSampleSubmit(){
 const attempt=useRef<{body:string;path:string;key:string}|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const send=async<T,>(path:string,data:unknown,schema:z.ZodType<T>):Promise<T|undefined>=>{
  const body=JSON.stringify(data);if(attempt.current?.body!==body||attempt.current.path!==path)attempt.current={body,path,key:createClientRequestId()};
  setBusy(true);setError('');try{return await read(path,schema,{method:'POST',body,headers:{'idempotency-key':attempt.current.key}});}
  catch(e){setError(e instanceof Error?e.message:'操作失败');return undefined;}finally{setBusy(false);}
 };return {busy,error,send,reset:()=>{attempt.current=null;}};
}
export function SampleWorkflowActions({sampleId}:{sampleId:string}){
 const [data,setData]=useState<z.infer<typeof SampleWorkflowViewSchema>|null>(null),[error,setError]=useState(''),[refresh,setRefresh]=useState(0);
 const [purpose,setPurpose]=useState(''),[borrower,setBorrower]=useState(''),[delegated,setDelegated]=useState(false),[reason,setReason]=useState('');
 const [photos,setPhotos]=useState<{attachmentId:string;filename:string}[]>([]),[uploading,setUploading]=useState(false),[qr,setQr]=useState<z.infer<typeof SampleHandoffQrSchema>|null>(null);
 const action=useSampleSubmit();
 useEffect(()=>{const abort=new AbortController();void read(`samples/${sampleId}/workflow`,SampleWorkflowViewSchema,{signal:abort.signal}).then(value=>{if(!abort.signal.aborted){setData(value);setError('');}}).catch(e=>{if(!abort.signal.aborted)setError(e instanceof Error?e.message:'无法读取可用操作');});return()=>abort.abort();},[sampleId,refresh]);
 const submit=async(name:string,fields:Record<string,unknown>)=>{if(!data)return;const result=await action.send(`samples/${sampleId}/${name}`,{version:data.version,...fields},SampleWorkflowResultSchema);if(result){setQr(null);setPhotos([]);setRefresh(value=>value+1);window.dispatchEvent(new Event('sample-updated'));}};
 if(!data)return error?<p role="alert">{error}</p>:null;
 if(!data.enabled)return null;
 const disabled=action.busy||uploading;
 return <Surface className="rework-v2-core"><h2>借还与交接</h2>{error||action.error?<p role="alert">{error||action.error}</p>:null}
  {data.request?<p>{data.request.requesterName} 发起{data.request.type==='borrow'?'借用':data.request.type==='return'?'归还':'处置'}{data.request.borrowerName?` · 持有人：${data.request.borrowerName}`:''}{data.request.purpose?` · 用途：${data.request.purpose}`:''}</p>:null}
  {data.canBorrow?<div className="rework-v2-grid"><label>借用用途<input value={purpose} disabled={disabled} onChange={e=>setPurpose(e.target.value)} /></label>
   <label><input type="checkbox" checked={delegated} disabled={disabled} onChange={e=>setDelegated(e.target.checked)} />代其他员工申请</label>
   {delegated?<SamplePersonPicker endpoint="samples/borrowers" label="借用人" value={borrower} onChange={setBorrower} disabled={disabled}/>:null}
   <Button disabled={disabled||!purpose.trim()||(delegated&&!borrower)} onClick={()=>{void submit('borrow',{purpose,...(delegated?{borrowerUserId:borrower}:{})});}}>申请借出</Button></div>:null}
  {data.canReturn?<div><p>上传当前样衣照片；行政确认收到之前，仍由当前持有人保管。</p><SampleImageUpload label="上传归还照片" value={photos} onChange={setPhotos} disabled={disabled} onBusy={setUploading}/>
   <Button disabled={disabled||!photos.length} onClick={()=>{void submit('return',{photoAttachmentIds:photos.map(file=>file.attachmentId)});}}>申请归还</Button></div>:null}
  {data.canIssueQr?<div><p>请行政先登录平台，再用钉钉扫一扫打开交接码，核对实物后确认。</p><Button disabled={disabled} onClick={()=>{void action.send(`samples/${sampleId}/handoff-qr`,{version:data.version},SampleHandoffQrSchema).then(value=>{if(value){setQr(value);action.reset();}});}}>生成交接码</Button>
   {qr?<figure><img width={240} height={240} src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(qr.svg)}`} alt="本次样衣交接二维码"/><figcaption>有效至 {new Date(qr.expiresAt).toLocaleTimeString('zh-CN')}，过期后重新生成。</figcaption></figure>:null}</div>:null}
  {data.canConfirm?<p>请实际收到或交付样衣后，使用钉钉扫一扫扫描申请人的交接码。</p>:null}
  {data.canCancel?<details><summary>撤销申请</summary><label>撤销原因<input value={reason} disabled={disabled} onChange={e=>setReason(e.target.value)}/></label><Button disabled={disabled||!reason.trim()} onClick={()=>{void submit('cancel',{reason});}}>确认撤销申请</Button></details>:null}
  {!data.canBorrow&&!data.canReturn&&!data.request?<p>当前没有可执行的借还事项。</p>:null}
 </Surface>;
}
export function SampleHandoffPage(){
 const token=useRef(window.location.hash.slice(1)),[data,setData]=useState<z.infer<typeof SampleHandoffLookupSchema>|null>(null),[error,setError]=useState(''),[location,setLocation]=useState(''),[confirmed,setConfirmed]=useState(false),action=useSampleSubmit();
 useEffect(()=>{const abort=new AbortController();window.history.replaceState(null,'',window.location.pathname+window.location.search);
  void read('samples/handoff/lookup',SampleHandoffLookupSchema,{method:'POST',body:JSON.stringify({token:token.current}),signal:abort.signal}).then(value=>{if(!abort.signal.aborted)setData(value);}).catch(e=>{if(!abort.signal.aborted)setError(e instanceof Error?e.message:'交接码无效');});return()=>abort.abort();},[]);
 return <Shell active="待确认中心" mobileNavigation="transaction"><main className="rework-v2-page"><Header title="样衣实物交接" subtitle="核对申请人和实物后确认。" badge="样衣管理"/>
  {error||action.error?<p role="alert">{error||action.error}</p>:null}{data?<Surface className="rework-v2-core"><p>申请人：{data.requesterName}</p><p>{data.type==='return'?'归还收货':'借出交付'}</p><a href={pageUrl(`ui/samples/${data.sampleId}`)}>查看样衣资料</a>
   {confirmed?<p role="status">交接已完成，同一事项的其他行政待办已结束。</p>:<><p>请确认实物已{data.type==='return'?'收到':'交付'}。</p>{data.type==='return'?<label>在库位置<input value={location} disabled={action.busy} onChange={e=>setLocation(e.target.value)}/></label>:null}
   <Button disabled={action.busy||(data.type==='return'&&!location.trim())} onClick={()=>{void action.send(`samples/${data.sampleId}/confirm`,{version:data.version,token:token.current,...(data.type==='return'?{storageLocation:location}:{})},SampleWorkflowResultSchema).then(value=>{if(value)setConfirmed(true);});}}>确认{data.type==='return'?'收到实物':'交付实物'}</Button></>}
  </Surface>:null}</main></Shell>;
}
export function SampleBatchReturn({items}:{items:SampleView[]}){
 const [enabled,setEnabled]=useState(false);
 const [user,setUser]=useState<{id:string;isRoot:boolean}|null>(null),[selected,setSelected]=useState<string[]>([]),[photos,setPhotos]=useState<{attachmentId:string;filename:string}[]>([]),[uploading,setUploading]=useState(false),[result,setResult]=useState<z.infer<typeof SampleBatchReturnResultSchema>|null>(null),action=useSampleSubmit();
 useEffect(()=>{let active=true;void verifySession().then(state=>{if(active&&typeof state==='object'&&state.status==='authorized'&&(state.user.isRoot||(state.user.capabilities.includes('sample:return_request')&&state.user.businessRoles?.some(role=>['sample_designer','owner_group'].includes(role)))))setUser({id:state.user.id,isRoot:!!state.user.isRoot});});return()=>{active=false;};},[]);
 useEffect(()=>{const abort=new AbortController();void read('samples/creation-availability',z.object({enabled:z.boolean()}),{signal:abort.signal}).then(value=>{if(!abort.signal.aborted)setEnabled(value.enabled);}).catch(()=>{});return()=>abort.abort();},[]);
 const eligible=items.filter(item=>item.status==='borrowed'&&(user?.isRoot||item.holderUserId===user?.id));
 useEffect(()=>{setSelected([]);setResult(null);},[items]);
 if(!enabled||!user||!eligible.length)return null;
 return <Surface className="rework-v2-core"><details><summary>批量归还</summary><p>选择本页需要归还的样衣，并上传能反映这些样衣当前状态的照片。</p>
  {eligible.map(item=><p key={item.sampleId}><label><input type="checkbox" disabled={action.busy||uploading} checked={selected.includes(item.sampleId)} onChange={e=>setSelected(ids=>e.target.checked?[...ids,item.sampleId]:ids.filter(id=>id!==item.sampleId))}/>{item.sampleCode} · {item.styleName}</label></p>)}
  <SampleImageUpload label="上传归还照片" value={photos} onChange={setPhotos} disabled={action.busy||uploading} onBusy={setUploading}/>
  {action.error?<p role="alert">{action.error}</p>:null}<Button disabled={action.busy||uploading||!selected.length||!photos.length} onClick={()=>{void action.send('samples/returns/batch',{items:eligible.filter(item=>selected.includes(item.sampleId)).map(item=>({sampleId:item.sampleId,version:item.version,photoAttachmentIds:photos.map(file=>file.attachmentId)}))},SampleBatchReturnResultSchema).then(value=>{if(value)setResult(value);});}}>提交所选样衣归还</Button>
  {result?.items.map(entry=><p key={entry.sampleId}>{eligible.find(item=>item.sampleId===entry.sampleId)?.sampleCode}：{entry.success?'已申请归还，待行政确认':entry.message}</p>)}
 </details></Surface>;
}
