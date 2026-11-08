import {useEffect,useState} from "react";
import {useLiveSearch} from "./use-live-search.js";

type QueueResult={items:readonly unknown[];page?:number|undefined;pageSize?:number|undefined;totalCount?:number|undefined};
type QueueState<T>= {kind:"loading"}|{kind:"ready";value:T}|{kind:"unavailable";message:string};
/** Only the selected page is held locally; counts remain the server's full authorized count. */
export function useRemoteQueue<T extends QueueResult>(url:string,schema:{parse:(value:unknown)=>T},failure:string){
 const [state,setState]=useState<QueueState<T>>({kind:"loading"});
 const [q,setQ]=useState(""),[search,setSearch]=useState(""),[current,setCurrent]=useState(1),[revision,setRevision]=useState(0);
 const searchInput=useLiveSearch(q,search,value=>{setSearch(value);setCurrent(1);});
 useEffect(()=>{
  const controller=new AbortController();setState({kind:"loading"});
  void (async()=>{
   try{
    const query=new URLSearchParams({page:String(current),search});
    const response=await fetch(url+"?"+query,{credentials:"include",signal:controller.signal,headers:{accept:"application/json"}});
    if(!response.ok)throw new Error(failure);
    const value=schema.parse(await response.json());
    if(value.page!==current||value.pageSize!==15||value.totalCount===undefined)throw new Error(failure);
    if(!controller.signal.aborted)setState({kind:"ready",value});
   }catch{
    if(!controller.signal.aborted)setState({kind:"unavailable",message:failure});
   }
  })();
  return()=>controller.abort();
 },[url,schema,failure,current,search,revision]);
 const total=state.kind==="ready"?state.value.totalCount!:0,totalPages=Math.max(1,Math.ceil(total/15));
 useEffect(()=>{if(state.kind==="ready"&&current>totalPages)setCurrent(totalPages);},[state,current,totalPages]);
 const page={page:current,totalPages,setPage:setCurrent,items:state.kind==="ready"?state.value.items:[]};
 return {state,q,setQ,searchInput:{onCompositionStart:searchInput.onCompositionStart,onCompositionEnd:searchInput.onCompositionEnd},total,page,retry:()=>setRevision(value=>value+1)};
}

