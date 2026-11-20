import {useCallback,useEffect,useState} from "react";
import {useForegroundRead} from "./use-foreground-read.js";
import {useForegroundWait} from "./foreground-loading.js";
import {useLiveSearch} from "./use-live-search.js";

type QueueResult={items:readonly unknown[];page?:number|undefined;pageSize?:number|undefined;totalCount?:number|undefined};
type QueueState<T>= {kind:"loading"}|{kind:"ready";value:T}|{kind:"unavailable";message:string};
/** Only the selected page is held locally; counts remain the server's full authorized count. */
export function useRemoteQueue<T extends QueueResult>(url:string,schema:{parse:(value:unknown)=>T},failure:string){
 const [q,setQ]=useState(""),[search,setSearch]=useState(""),[current,setCurrent]=useState(1);
 const searchInput=useLiveSearch(q,search,value=>{setSearch(value);setCurrent(1);});
 const query=new URLSearchParams({page:String(current),search}).toString();
 const load=useCallback(async(signal:AbortSignal)=>{
  const response=await fetch(url+"?"+query,{credentials:"include",signal,headers:{accept:"application/json"}});
  if(!response.ok)throw Error(failure);
  const value=schema.parse(await response.json());
  if(value.page!==current||value.pageSize!==15||value.totalCount===undefined)throw Error(failure);
  return value;
 },[url,query,schema,current,failure]);
 const read=useForegroundRead(url,query,load,true);
 useForegroundWait(searchInput.pending?undefined:read.foregroundKey);
 const state:QueueState<T>=read.error?{kind:"unavailable",message:failure}:read.value?{kind:"ready",value:read.value}:{kind:"loading"};
 const total=read.value?.totalCount??0,totalPages=Math.max(1,Math.ceil(total/15));
 useEffect(()=>{if(read.value&&!read.waiting&&current>totalPages)setCurrent(totalPages);},[read.value,read.waiting,current,totalPages]);
 const page={page:read.value?.page??current,totalPages,setPage:setCurrent,items:read.value?.items??[]};
 return {state,q,setQ,searchInput:{onCompositionStart:searchInput.onCompositionStart,onCompositionEnd:searchInput.onCompositionEnd},total,page,retry:read.retry};
}
