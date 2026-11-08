import {useCallback,useEffect,useRef,useState} from "react";
import {
  SourcingCaseSummarySchema,SourcingAttachmentListResponseSchema,SourcingTimelineResponseSchema,
  SourcingFactoryChangeStateResponseSchema,SourcingContractStateResponseSchema,
  SourcingDispatchStateSchema,SourcingContractReturnResponseSchema,
} from "@dx-rework/contracts";

export type SourcingDetailRequest = <T>(path:string,schema:{parse(value:unknown):T},init?:RequestInit)=>Promise<T>;
export type SourcingDetailIdentity = Readonly<{caseId:string;epoch:number}>;

export async function readSourcingDetail(request:SourcingDetailRequest,caseId:string,signal:AbortSignal){
  const path=`sourcing/cases/${caseId}`,init={signal};
  const [item,attachments,timeline,factoryChange,contract,dispatch,contractReturn]=await Promise.all([
    request(path,SourcingCaseSummarySchema,init),
    request(path+"/attachments",SourcingAttachmentListResponseSchema,init),
    request(path+"/timeline",SourcingTimelineResponseSchema,init),
    request(path+"/factory-changes/current",SourcingFactoryChangeStateResponseSchema,init),
    request(path+"/contract",SourcingContractStateResponseSchema,init),
    request(path+"/dispatch",SourcingDispatchStateSchema,init),
    request(path+"/contract-return",SourcingContractReturnResponseSchema,init),
  ]);
  if(item.sourcingCaseId!==caseId)throw Error("订单资料与当前页面不一致，请重新读取");
  return {item,attachments:attachments.items,timeline:timeline.items,factoryChange:factoryChange.item,
    factoryRemainingLines:factoryChange.remainingLines,contract:contract.item,dispatchState:dispatch,contractReturn};
}
export type SourcingDetailSnapshot=Awaited<ReturnType<typeof readSourcingDetail>>;

/** One entity lifetime owns writes; a separate monotonic read generation owns
 * GET results. Refreshing or changing chapters never cancels a business write. */
export function useSourcingDetailRead(caseId:string,request:SourcingDetailRequest,enabled=true){
  const owner=useRef({caseId,epoch:0,live:false}),sequence=useRef(0),controller=useRef<AbortController|null>(null);
  const [state,setState]=useState<{caseId:string;snapshot:SourcingDetailSnapshot|null;loading:boolean;error:string}>({caseId,snapshot:null,loading:enabled,error:""});
  const capture=useCallback(():SourcingDetailIdentity=>({caseId,epoch:owner.current.epoch}),[caseId]);
  const owns=useCallback((identity:SourcingDetailIdentity)=>owner.current.live
    &&owner.current.caseId===identity.caseId&&owner.current.epoch===identity.epoch,[]);

  useEffect(()=>{
    owner.current={caseId,epoch:owner.current.epoch+1,live:true};
    return()=>{owner.current.live=false;owner.current.epoch++;sequence.current++;controller.current?.abort();};
  },[caseId]);

  const reload=useCallback(async():Promise<SourcingDetailSnapshot|null>=>{
    const identity=capture();if(!owns(identity))return null;
    const version=++sequence.current;
    controller.current?.abort();const current=new AbortController();controller.current=current;
    const accepts=()=>owns(identity)&&sequence.current===version;
    setState(previous=>accepts()?{caseId,snapshot:previous.snapshot?.item.sourcingCaseId===caseId?previous.snapshot:null,loading:true,error:""}:previous);
    try{
      const snapshot=await readSourcingDetail(request,caseId,current.signal);
      if(!accepts()||current.signal.aborted)return null;
      setState(previous=>accepts()?{caseId,snapshot,loading:false,error:""}:previous);return snapshot;
    }catch(error){
      if(!accepts()||current.signal.aborted)return null;
      setState(previous=>accepts()?{...previous,loading:false,error:error instanceof Error?error.message:"订单加载失败"}:previous);
      throw error;
    }finally{
      if(accepts())setState(previous=>accepts()&&previous.loading?{...previous,loading:false}:previous);
    }
  },[caseId,request,capture,owns]);

  useEffect(()=>{
    if(enabled)void reload().catch(()=>undefined);
    return()=>{sequence.current++;controller.current?.abort();};
  },[enabled,reload]);

  const apply=useCallback((identity:SourcingDetailIdentity,patch:Partial<SourcingDetailSnapshot>)=>{
    if(!owns(identity)||patch.item&&patch.item.sourcingCaseId!==identity.caseId)return;
    setState(previous=>owns(identity)&&previous.snapshot?.item.sourcingCaseId===identity.caseId
      ?{...previous,snapshot:{...previous.snapshot,...patch}}:previous);
  },[owns]);
  const snapshot=state.snapshot?.item.sourcingCaseId===caseId?state.snapshot:null;
  return {snapshot,loading:state.caseId!==caseId||state.loading,error:state.caseId===caseId?state.error:"",reload,apply,capture,owns,
    canSubmit:enabled&&snapshot!==null&&state.caseId===caseId&&!state.loading&&!state.error&&!controller.current?.signal.aborted};
}
