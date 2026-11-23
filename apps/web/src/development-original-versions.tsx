import {useEffect,useState} from 'react';
import {Button} from '@astryxdesign/core/Button';
import {TextInput} from '@astryxdesign/core/TextInput';
import type {DevelopmentPublishedVersions} from '@dx-rework/contracts/digital-development';
import {registerSessionInvalidator} from './auth-session.js';
import {digitalRequest} from './digital-production-api.js';
import {DigitalReadFailure} from './digital-read-failure.js';
import {ListPagination} from './list-pagination.js';
import {useDebouncedValue} from './use-debounced-value.js';

export type DevelopmentOriginalRef={roundNumber:number;documentVersion:number};

/** Only authorized publication metadata; selecting a row fetches its body.
 * Search belongs to the server's complete version set, never the visible page.
 */
export function DevelopmentOriginalVersions({sourceId,onSelect,onReady,searchQuery,page:controlledPage,onPage}:{sourceId:string;onSelect(ref:DevelopmentOriginalRef):void;onReady?:(ready:boolean)=>void;searchQuery?:string|undefined;page?:number;onPage?:((page:number)=>void)|undefined}){
 const [search,setSearch]=useState(''),term=searchQuery??search,q=useDebouncedValue(term.trim(),250),[localPage,setLocalPage]=useState(1),[attempt,setAttempt]=useState(0);
 const page=controlledPage??localPage,setPage=onPage??setLocalPage;
 const [result,setResult]=useState<{key:string;value:DevelopmentPublishedVersions}|null>(null),[failure,setFailure]=useState<{key:string;error:unknown}|null>(null);
 const key=JSON.stringify([sourceId,q,page,attempt]),applied=term.trim()===q;
 useEffect(()=>registerSessionInvalidator(()=>{setResult(null);setFailure(null);setAttempt(value=>value+1);}),[]);
 useEffect(()=>{
  if(!applied)return;
  const abort=new AbortController();setFailure(null);
  void digitalRequest<DevelopmentPublishedVersions>(`sources/${sourceId}/development/published-versions?${new URLSearchParams({q,page:String(page)})}`,'GET',undefined,undefined,{signal:abort.signal})
   .then(value=>{
    if(abort.signal.aborted)return;
    if(value.sourceId!==sourceId||value.page!==page||value.pageSize!==15||!Number.isSafeInteger(value.total)||value.total<0||!Array.isArray(value.items)||value.items.some(item=>!Number.isSafeInteger(item.roundNumber)||item.roundNumber<1||!Number.isSafeInteger(item.documentVersion)||item.documentVersion<1))throw new Error('原单目录的对象或版本不符，未打开其他记录');
    setResult({key,value});
   }).catch(error=>{if(!abort.signal.aborted){setResult(null);setFailure({key,error});}});
  return()=>abort.abort();
 },[sourceId,q,page,applied,key]);
 const current=applied&&result?.key===key?result.value:null,error=failure?.key===key?failure.error:null,reading=!current&&!error;
 useEffect(()=>{onReady?.(Boolean(current||error));return()=>onReady?.(false);},[current,error,onReady]);
 return <section aria-label="开发资料原版本">
  {searchQuery===undefined&&<TextInput label="搜索原单与版本" value={search} onChange={value=>{setSearch(value);setPage(1);}} ref={input=>{if(input)input.maxLength=100;}}/>}
  <h2>开发资料</h2>
  {reading&&<p role="status">正在读取授权原单目录…</p>}
  {error?<DigitalReadFailure error={error} onRetry={()=>setAttempt(value=>value+1)} retryLabel="重新读取原单目录"/>:null}
  {current&&(current.items.length?<ul>{current.items.map(item=><li key={`${item.roundNumber}:${item.documentVersion}`}><Button label={`开发单 · 第${item.roundNumber}轮 · 资料版本 ${item.documentVersion} · 已发布`} onClick={()=>onSelect(item)}/>{item.reason&&<p>{item.reason}</p>}</li>)}</ul>:<p>{current.total?'本页没有记录，请返回有效页码。':'当前授权范围没有匹配的已发布原单。'}</p>)}
  {current&&(current.total>current.pageSize||page>1)&&<ListPagination page={page}
    totalPages={Math.max(1,Math.ceil(current.total/current.pageSize))} total={current.total}
    busy={reading||!applied} onPageChange={setPage} ariaLabel="原单版本分页"/>}
 </section>;
}
