import { historicalSourcingPrice } from "./sourcing-price-presentation.js";
import { useEffect,useRef,useState } from "react";
import { RequestSourcingPriceReapplicationSchema,type SourcingCaseSummary,type SourcingContractDocument,type SourcingPriceReapplicationState } from "@dx-rework/contracts";
import { formatBusinessCurrency } from "@dx-rework/contracts/business-display";
import { createClientRequestId } from "./client-request-id.js";

type Props={item:SourcingCaseSummary;contract:SourcingContractDocument|null;canStart:boolean;canReview:boolean;isRoot:boolean;userId:string;busy:boolean;
  read:()=>Promise<SourcingPriceReapplicationState>;save:(path:string,body:unknown,key:string)=>Promise<void>};
export function SourcingPriceReapplicationPanel({item,contract,canStart,canReview,isRoot,userId,busy,read,save}:Props) {
  const [state,setState]=useState<SourcingPriceReapplicationState>({item:null});
  const [editing,setEditing]=useState(false);
  const [open,setOpen]=useState(false),[price,setPrice]=useState(""),[reason,setReason]=useState(""),[reviewReason,setReviewReason]=useState("");
  const [error,setError]=useState(""),[loaded,setLoaded]=useState(false);
  const [basis,setBasis]=useState<{decisionId:string;documentId:string}|null>(null);
  const requestKey=useRef<string|null>(null),saving=useRef(false);
  useEffect(()=>{
    let active=true;setLoaded(false);
    void read().then(result=>{if(active){setState(result);setLoaded(true);setError("");}}).catch(failure=>{if(active)setError(failure instanceof Error?failure.message:"价格申请加载失败，请重试");});
    return ()=>{active=false;};
  },[item.sourcingCaseId,item.version,contract?.sourcingContractDocumentId]);
  const pending=state.item?.status==="pending"?state.item:null;
  const changed=!!basis&&(basis.decisionId!==item.decision?.sourcingDecisionId||basis.documentId!==contract?.sourcingContractDocumentId);
  const payload={unitPrice:price,changeReason:reason,expectedDecisionId:basis?.decisionId,expectedContractDocumentId:basis?.documentId};
  const valid=RequestSourcingPriceReapplicationSchema.safeParse(payload).success;
  const run=async(path:string,body:unknown)=>{
    if(busy||saving.current)return;saving.current=true;setError("");
    const key=requestKey.current??createClientRequestId();requestKey.current=key;
    try {await save(path,body,key);requestKey.current=null;setOpen(false);setReason("");setReviewReason("");setState(await read());}
    catch(failure){setError(failure instanceof Error?failure.message:"价格申请提交失败，请重试");}
    finally{saving.current=false;}
  };
  if(!canStart&&!pending)return null;
  return <section className="sourcing-factory-change" aria-label="价格重新申请">
    {pending?<>
      <h2>价格重新申请 · 待老板审批</h2>
      <p>申请单价 {formatBusinessCurrency(pending.unitPrice)}/件 · {pending.reason}</p>
      {pending.basisChanged?<p role="status">有效价格或合同已变化，请驳回或撤销后重新申请。</p>:null}
      {(canReview||canStart&&(isRoot||pending.requestedBy===userId))?<div className="sourcing-owner-actions">
        <label><span>处理说明</span><input maxLength={500} value={reviewReason} onChange={event=>{setReviewReason(event.target.value);requestKey.current=null;}}/></label>
        <div>{canReview?<>
          <button className="dx-button dx-button--primary" type="button" disabled={busy||!reviewReason.trim()||pending.basisChanged} onClick={()=>void run(`sourcing/cases/${item.sourcingCaseId}/price-reapplications/${pending.priceRequestId}/decision`,{decision:"approved",verificationReason:reviewReason.trim()})}>批准调价</button>
          <button className="dx-button dx-button--secondary" type="button" disabled={busy||!reviewReason.trim()} onClick={()=>void run(`sourcing/cases/${item.sourcingCaseId}/price-reapplications/${pending.priceRequestId}/decision`,{decision:"rejected",verificationReason:reviewReason.trim()})}>驳回调价</button>
          <button className="dx-button dx-button--secondary" type="button" disabled={busy||!reviewReason.trim()} onClick={()=>void run(`sourcing/cases/${item.sourcingCaseId}/price-reapplications/${pending.priceRequestId}/decision`,{decision:"returned",verificationReason:reviewReason.trim()})}>退回申请</button>
        </>:null}{canStart&&(isRoot||pending.requestedBy===userId)?<button className="dx-button dx-button--secondary" type="button" disabled={busy||!reviewReason.trim()} onClick={()=>void run(`sourcing/cases/${item.sourcingCaseId}/price-reapplications/${pending.priceRequestId}/decision`,{decision:"cancelled",verificationReason:reviewReason.trim()})}>撤销申请</button>:null}</div>
      </div>:null}
    </>:canStart&&item.approvalSnapshot&&item.decision&&contract?<>
      {!open?<button className="dx-button dx-button--secondary" type="button" disabled={busy||!loaded} onClick={()=>{
        setBasis({decisionId:item.decision!.sourcingDecisionId,documentId:contract.sourcingContractDocumentId});setPrice(item.decision!.unitPrice);setOpen(true);requestKey.current=null;
      }}>重新申请</button>:<form className="sourcing-form-grid" onSubmit={event=>{event.preventDefault();if(valid&&!changed)void run(`sourcing/cases/${item.sourcingCaseId}/price-reapplications`,payload);}}>
        <h2 className="sourcing-form-wide">同厂价格重新申请</h2>
        <p className="sourcing-form-wide">加工厂：{item.decision.supplierName} · 交货日期：{item.deliveryDate??"未填写"} · 合同 V{contract.contractVersion}</p>
        <label><span>当前批准单价</span><input readOnly value={historicalSourcingPrice(item.decision.unitPrice).slice(1)}/></label>
        <label><span>重新申请单价</span><input inputMode="decimal" value={editing||!price?price:historicalSourcingPrice(price).slice(1)} onFocus={()=>setEditing(true)} onBlur={()=>setEditing(false)} onChange={event=>{setPrice(event.target.value.replace(/,/g,""));requestKey.current=null;}}/></label>
        <p className="sourcing-form-wide">本次单价统一用于本单款色，沿用转厂价格审批规则。</p>
        <label className="sourcing-form-wide"><span>重新申请原因</span><input maxLength={500} value={reason} onChange={event=>{setReason(event.target.value);requestKey.current=null;}}/></label>
        {changed?<p className="sourcing-form-wide" role="status">合同或价格基准已变化，请取消后重新打开申请。</p>:null}
        <div className="sourcing-form-wide sourcing-owner-actions"><button className="dx-button dx-button--primary" type="submit" disabled={busy||!valid||changed}>提交价格申请</button><button className="dx-button dx-button--secondary" type="button" disabled={busy} onClick={()=>setOpen(false)}>取消</button></div>
      </form>}
    </>:null}
    {error?<p role="alert">{error} <button className="dx-button dx-button--secondary" type="button" disabled={busy} onClick={()=>void read().then(result=>{setState(result);setLoaded(true);setError("");}).catch(failure=>setError(failure instanceof Error?failure.message:"读取失败"))}>重新读取</button></p>:null}
  </section>;
}
