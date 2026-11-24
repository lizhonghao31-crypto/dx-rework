import {useCallback,useEffect,useRef,useState} from "react";
import {useForegroundWait} from "./foreground-loading.js";
import {SubmissionRequestError} from "./submission-validation.js";
import {
  SourcingCaseSummarySchema,SourcingDetailSectionsSchema,SourcingOwnerDetailSectionsSchema,SourcingContractStateResponseSchema,
  SourcingAttachmentListResponseSchema,SourcingTimelineResponseSchema,SourcingFactoryChangeStateResponseSchema,
  type SourcingCaseSummary,type SourcingAttachment,type SourcingContractDocument,type SourcingOwnerReview,
  SourcingDispatchStateSchema,SourcingContractReturnResponseSchema,
} from "@dx-rework/contracts";

export type SourcingDetailRequest = <T>(path:string,schema:{parse(value:unknown):T},init?:RequestInit)=>Promise<T>;
export type SourcingDetailIdentity = Readonly<{caseId:string;epoch:number}>;

type ReadOnlySections={attachments?:SourcingAttachment[];contract?:SourcingContractDocument|null};
type DetailObserver={
  item?:(item:SourcingCaseSummary)=>void;
  sections?:(sections:ReadOnlySections)=>void;
  recordsFailed?:()=>void;
  denied?:(error:SubmissionRequestError)=>void;
};
class SourcingDetailRevisionError extends Error {}
const isReadDenial=(error:unknown):error is SubmissionRequestError=>error instanceof SubmissionRequestError&&[401,403,404].includes(error.status);
const sameApprovedRevision=(left:SourcingCaseSummary,right:SourcingCaseSummary)=>
  left.sourcingCaseId===right.sourcingCaseId&&left.version===right.version&&
  left.approvalSnapshot?.sourcingApprovalSnapshotId===right.approvalSnapshot?.sourcingApprovalSnapshotId;

const compatibleOwnerSections=SourcingOwnerDetailSectionsSchema.partial({ownerReview:true});

export async function readSourcingDetail(request:SourcingDetailRequest,caseId:string,signal:AbortSignal,observer?:DetailObserver,nativeRecords=false,includeOwnerReview=false){
  const path=`sourcing/cases/${caseId}`,init={signal};
  const read=<T>(url:string,schema:{parse(value:unknown):T})=>request(url,schema,init).catch((error:unknown)=>{
    if(isReadDenial(error))observer?.denied?.(error);
    throw error;
  });
  const summary=read(path,SourcingCaseSummarySchema).then(item=>{
    if(item.sourcingCaseId!==caseId)throw new SourcingDetailRevisionError("订单资料与当前页面不一致，请重新读取");
    observer?.item?.(item);
    return item;
  });
  const grouped=()=>includeOwnerReview
    ? read(path+"/detail-sections?ownerReview=1",compatibleOwnerSections)
    : read(path+"/detail-sections",SourcingDetailSectionsSchema).then(value=>({...value,ownerReview:null}));
  const recordsRead=nativeRecords?summary.then(async item=>{
    // Only the grouped snapshot can provide a pending approval action.
    if(includeOwnerReview&&item.status==="pending_owner_approval")return grouped();
    // The ordinary grouped read stays the fast path. On explicit retry,
    // use the established authorized endpoints and verify the order again.
    const [attachments,timeline,factoryChange]=await Promise.all([
      read(path+"/attachments",SourcingAttachmentListResponseSchema),
      read(path+"/timeline",SourcingTimelineResponseSchema),
      read(path+"/factory-changes/current",SourcingFactoryChangeStateResponseSchema),
    ]);
    const current=await read(path,SourcingCaseSummarySchema);
    if(current.sourcingCaseId!==item.sourcingCaseId||current.version!==item.version)
      throw new SourcingDetailRevisionError("本单已更新，请重新读取原订单资料");
    return {sourcingCaseId:caseId,version:item.version,attachments,timeline,factoryChange,ownerReview:null};
  }):grouped();
  const sections=Promise.all([summary,recordsRead]).then(([item,value])=>{
    const viewed=value.ownerReview?.item;
    if(value.sourcingCaseId!==caseId||value.version!==item.version||viewed&&(
      viewed.sourcingCaseId!==caseId||viewed.status!==item.status||viewed.version!==item.version
      ||viewed.decision?.sourcingDecisionId!==item.decision?.sourcingDecisionId||viewed.decision?.decisionVersion!==item.decision?.decisionVersion))
      throw new SourcingDetailRevisionError("本单已更新，请重新读取原订单资料");
    observer?.sections?.({attachments:value.attachments.items});
    return value;
  }).catch((error:unknown)=>{
    if(!isReadDenial(error)&&!(error instanceof SourcingDetailRevisionError))observer?.recordsFailed?.();
    throw error;
  });
  const currentContract=Promise.all([summary,read(path+"/contract",SourcingContractStateResponseSchema),
    read(path+"/contract-return",SourcingContractReturnResponseSchema)]).then(([item,contract,contractReturn])=>{
    if(contract.item&&contractReturn.currentContractDocumentId&&contract.item.sourcingContractDocumentId!==contractReturn.currentContractDocumentId)
      throw new SourcingDetailRevisionError("本单已更新，请重新读取原订单资料");
    if(contract.item&&contractReturn.currentContractDocumentId===contract.item.sourcingContractDocumentId&&
      item.approvalSnapshot?.sourcingApprovalSnapshotId===contract.item.sourcingApprovalSnapshotId)
      observer?.sections?.({contract:contract.item});
    return {contract:contract.item,contractReturn};
  });
  const dispatch=read(path+"/dispatch",SourcingDispatchStateSchema);
  const supporting=Promise.all([sections,currentContract,dispatch]);
  // An ancillary error cannot take the authorized summary off its own read path.
  void supporting.catch(()=>undefined);
  const item=await summary;
  const [records,contractReads,dispatchState]=await supporting;
  const ownerReview:SourcingOwnerReview|null=records.ownerReview??null;
  return {item:ownerReview?.item??item,ownerReview,attachments:records.attachments.items,timeline:records.timeline.items,factoryChange:records.factoryChange.item,
    factoryRemainingLines:records.factoryChange.remainingLines,...contractReads,dispatchState};
}
export type SourcingDetailSnapshot=Awaited<ReturnType<typeof readSourcingDetail>>;

/** One entity lifetime owns writes; a separate monotonic read generation owns
 * GET results. Refreshing or changing chapters never cancels a business write. */
export function useSourcingDetailRead(caseId:string,request:SourcingDetailRequest,enabled=true,includeOwnerReview=false){
  const owner=useRef({caseId,epoch:0,live:false}),sequence=useRef(0),controller=useRef<AbortController|null>(null);
  const [state,setState]=useState<{caseId:string;snapshot:SourcingDetailSnapshot|null;overview:SourcingCaseSummary|null;readOnly:ReadOnlySections;loading:boolean;waitingFor:number|null;error:string;recordsFailed:boolean}>({caseId,snapshot:null,overview:null,readOnly:{},loading:enabled,waitingFor:null,error:"",recordsFailed:false});
  const retryingRecords=useRef(false);
  const capture=useCallback(():SourcingDetailIdentity=>({caseId,epoch:owner.current.epoch}),[caseId]);
  const owns=useCallback((identity:SourcingDetailIdentity)=>owner.current.live
    &&owner.current.caseId===identity.caseId&&owner.current.epoch===identity.epoch,[]);

  useEffect(()=>{
    owner.current={caseId,epoch:owner.current.epoch+1,live:true};
    return()=>{owner.current.live=false;owner.current.epoch++;sequence.current++;controller.current?.abort();};
  },[caseId]);

  const readAttempt=useCallback(async(nativeRecords:boolean,foreground=false):Promise<SourcingDetailSnapshot|null>=>{
    const identity=capture();if(!owns(identity))return null;
    if(foreground&&controller.current&&!controller.current.signal.aborted)return null;
    const version=++sequence.current;
    controller.current?.abort();const current=new AbortController();controller.current=current;
    const accepts=()=>owns(identity)&&sequence.current===version;
    let accessLost=false;
    const expose=(patch:Partial<{overview:SourcingCaseSummary;readOnly:ReadOnlySections}>)=>{
      if(!accepts()||current.signal.aborted||accessLost)return;
      setState(previous=>{
        if(!accepts()||accessLost)return previous;
        const authoritativelyChanged=patch.overview&&previous.snapshot&&!sameApprovedRevision(previous.snapshot.item,patch.overview);
        return {...previous,...patch,
          snapshot:authoritativelyChanged?null:previous.snapshot,
          readOnly:{...previous.readOnly,...patch.readOnly},
        };
      });
    };
    setState(previous=>accepts()?{caseId,snapshot:previous.snapshot?.item.sourcingCaseId===caseId?previous.snapshot:null,overview:previous.caseId===caseId?previous.overview:null,readOnly:{},loading:true,waitingFor:foreground?version:null,error:"",recordsFailed:false}:previous);
    try{
      const snapshot=await readSourcingDetail(request,caseId,current.signal,{
        item:overview=>expose({overview}),sections:readOnly=>expose({readOnly}),
        recordsFailed:()=>{
          if(accepts()&&!current.signal.aborted&&!accessLost)
            setState(previous=>accepts()?{...previous,recordsFailed:true}:previous);
        },
        denied:error=>{
          if(!accepts()||current.signal.aborted)return;
          accessLost=true;
          setState(previous=>accepts()?{...previous,snapshot:null,overview:null,readOnly:{},loading:false,waitingFor:null,error:error.message,recordsFailed:false}:previous);
        },
      },nativeRecords,includeOwnerReview);
      if(!accepts()||current.signal.aborted)return null;
      setState(previous=>accepts()?{caseId,snapshot,overview:snapshot.item,readOnly:{},loading:false,waitingFor:null,error:"",recordsFailed:false}:previous);return snapshot;
    }catch(error){
      if(!accepts()||current.signal.aborted)return null;
      const denied=accessLost||isReadDenial(error);
      const revisionChanged=error instanceof SourcingDetailRevisionError;
      accessLost=denied||revisionChanged;
      setState(previous=>accepts()?{...previous,
        ...(denied?{overview:null,recordsFailed:false}:{}),
        ...(accessLost?{snapshot:null,readOnly:{}}:{}),
        loading:false,waitingFor:null,error:error instanceof Error?error.message:"订单加载失败"}:previous);
      throw error;
    }finally{
      if(controller.current===current)controller.current=null;
      if(accepts())setState(previous=>accepts()&&previous.loading?{...previous,loading:false,waitingFor:null}:previous);
    }
  },[caseId,request,capture,owns,includeOwnerReview]);
  const reload=useCallback(()=>readAttempt(false),[readAttempt]);
  const reloadForeground=useCallback(()=>readAttempt(false,true),[readAttempt]);
  const retryRecords=useCallback(async()=>{
    if(retryingRecords.current)return;
    retryingRecords.current=true;
    try{await readAttempt(true,true);}finally{retryingRecords.current=false;}
  },[readAttempt]);

  useEffect(()=>{
    if(enabled)void reloadForeground().catch(()=>undefined);
    return()=>{sequence.current++;controller.current?.abort();};
  },[enabled,reloadForeground]);

  const apply=useCallback((identity:SourcingDetailIdentity,patch:Partial<SourcingDetailSnapshot>)=>{
    if(!owns(identity)||patch.item&&patch.item.sourcingCaseId!==identity.caseId)return;
    setState(previous=>owns(identity)&&previous.snapshot?.item.sourcingCaseId===identity.caseId
      ?{...previous,snapshot:{...previous.snapshot,...patch}}:previous);
  },[owns]);
  useForegroundWait(enabled&&state.caseId===caseId&&state.waitingFor!==null?JSON.stringify([caseId,state.waitingFor]):undefined);
  const snapshot=state.snapshot?.item.sourcingCaseId===caseId?state.snapshot:null;
  return {snapshot,overview:state.caseId===caseId?state.overview:null,readOnly:state.caseId===caseId?state.readOnly:{},loading:state.caseId!==caseId||state.loading,error:state.caseId===caseId?state.error:"",recordsFailed:state.caseId===caseId&&state.recordsFailed,reload,reloadForeground,retryRecords,apply,capture,owns,
    canSubmit:enabled&&snapshot!==null&&state.caseId===caseId&&!state.loading&&!state.error&&!controller.current?.signal.aborted};
}
