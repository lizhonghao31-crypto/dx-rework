import {useCallback,useRef,useState} from 'react';
import {Button} from '@astryxdesign/core/Button';
import {TextInput} from '@astryxdesign/core/TextInput';
import {formatBusinessDecimal} from '@dx-rework/contracts/business-display';
import {calculateQuotationPricing,QuotationPricingInputSchema,QuotationWorkbenchPreviewSchema,SaveQuotationPricingDraftSchema,type QuotationPricingInput}
  from '@dx-rework/contracts/digital-quotation';
import {sessionCacheVersion} from './auth-session.js';
import {createClientRequestId} from './client-request-id.js';
import {digitalRequest,DigitalRequestError} from './digital-production-api.js';
import {useForegroundRead} from './use-foreground-read.js';
import {useForegroundWait} from './foreground-loading.js';
import {confirmsQuotationPricingDraft} from './quotation-pricing-draft-receipt.js';
import {useSubmissionFeedback} from './submission-feedback.js';
import {SubmissionRequestError} from './submission-validation.js';
import {useDigitalDetailNavigationGuard} from './use-digital-detail-navigation-guard.js';

const statusLabels={
  awaiting_correction:'待修改',awaiting_review:'待复核',incomplete:'待补齐',
  awaiting_craft_approval:'待工艺审批',awaiting_customer_confirmation:'报价资料已齐',
} as const;

function previewDecimal(value:string){
  const display=formatBusinessDecimal(value,1);
  return display==='0'&&/[1-9]/.test(value)?'<0.1':display;
}

function multiplierPreview({numerator,denominator}:NonNullable<ReturnType<typeof calculateQuotationPricing>['exactMultiplierPercent']>){
  const dividend=BigInt(numerator),divisor=BigInt(denominator);
  const tenths=(dividend*10n+divisor/2n)/divisor;
  if(tenths===0n&&dividend>0n)return '<0.1';
  return previewDecimal(`${tenths/10n}.${tenths%10n}`);
}

export function QuotationWorkbenchPricing({path,quoteId,version,refresh,disabled,rowNames,onAdopt}:{
  path:string;quoteId:string;version:number;refresh:number;disabled:boolean;rowNames:ReadonlyMap<string,string>;
  onAdopt:(input:QuotationPricingInput,price:string)=>void;
}){
  const [editing,setEditing]=useState<{input:QuotationPricingInput;costAtEdit:string|null}|null>(null);
  const [focused,setFocused]=useState<{field:QuotationPricingInput['field'];element:HTMLElement}|null>(null);
  const [composing,setComposing]=useState(false);
  const [saving,setSaving]=useState(false),[receipt,setReceipt]=useState<{path:string;quoteId:string;version:number}|null>(null);
  const writing=useRef(false),feedback=useSubmissionFeedback(setSaving);
  useDigitalDetailNavigationGuard(feedback.uncertain,saving,writing,'上次报价测算保存仍需核对，确定离开？');
  const load=useCallback(async(signal:AbortSignal)=>{
    const result=QuotationWorkbenchPreviewSchema.parse(await digitalRequest(
      `${path}/workbench-pricing`,'GET',undefined,undefined,{signal},
    ));
    const resourcePath=`${result.resource.kind==='order'?'orders':'sources'}/${result.resource.id}/quotation`;
    if(resourcePath!==path||result.quoteId!==quoteId||result.version!==version)throw Error('报价版本已更新，请重新读取本单报价。');
    return result;
  },[path,quoteId,version]);
  const read=useForegroundRead('workbench-quotation-pricing',`${path}:${quoteId}:${version}:${refresh}`,load);
  useForegroundWait(read.foregroundKey);
  const recentSave=receipt?.path===path&&receipt.quoteId===quoteId&&receipt.version===version;
  if(read.error&&!feedback.uncertain)return <p role="alert">{recentSave?'报价测算已保存，重新读取失败。 ':''}{read.error.message} <Button label="重新读取成本" onClick={read.retry}/></p>;
  if(!read.value&&feedback.uncertain)return <p role="alert">{feedback.notice}
    <Button label="核对原报价测算保存结果" isDisabled={saving} onClick={()=>void feedback.retry()}/></p>;
  if(!read.value)return null;

  const current=read.value, draft=editing?.input??current.saved?.input??null;
  const validDraft=draft!==null&&QuotationPricingInputSchema.safeParse(draft).success;
  const result=draft&&validDraft&&!composing?calculateQuotationPricing(current.unitCost,draft):null;
  const fieldValue=(field:QuotationPricingInput['field'],calculated:string|null|undefined)=>{
    const authored=draft?.field===field;
    const value=authored?draft.value:calculated??'';
    // Compact display is never used as calculation/adoption input. Focusing a field
    // exposes the underlying number without making it the user's last input.
    if(!value||(focused?.field===field&&focused.element.ownerDocument.activeElement===focused.element)||(authored&&!validDraft))return value;
    const exactRate=field==='multiplier'&&!authored?result?.exactMultiplierPercent:null;
    return exactRate?multiplierPreview(exactRate):previewDecimal(value);
  };
  const edit=(field:QuotationPricingInput['field'],value:string)=>setEditing({input:{field,value},costAtEdit:current.unitCost});
  const costChanged=editing?editing.costAtEdit!==current.unitCost:
    current.saved!==null&&current.saved.version!==current.version;
  const savedInput=current.saved?.input;
  const savedSummary=savedInput?.field==='multiplier'?{label:'报价倍率',unit:'%'}:{label:'客户单件报价',unit:' 元/件'};
  const error=draft&&!composing&&draft.value!==''&&!result?'请输入最多六位小数的非负数字'
    :result?.status==='price_out_of_range'?'按此倍率计算的客户单价超出金额范围':null;
  const unavailable=disabled||read.waiting||saving||feedback.uncertain;
  const save=()=>{
    if(unavailable||writing.current||current.confirmation!=='joint_release_ready'||!editing||!result?.customerUnitPrice)return;
    const checked=SaveQuotationPricingDraftSchema.safeParse({expectedVersion:version,input:editing.input});
    if(!checked.success)return;
    const actor=sessionCacheVersion(),key=createClientRequestId();
    void feedback.run(async()=>{
      if(actor!==sessionCacheVersion())throw new SubmissionRequestError('登录身份已变化，请在原账号核对。','FORBIDDEN',403);
      writing.current=true;
      try{
        const response=await digitalRequest(`${path}/workbench-pricing`,'PUT',checked.data,key);
        if(actor!==sessionCacheVersion()||!confirmsQuotationPricingDraft(response,{resource:current.resource,quoteId,version}))
          throw new DigitalRequestError('未收到本单本版的报价测算保存回执。',200,'INVALID_RESPONSE');
        feedback.confirmed();setReceipt({path,quoteId,version});setEditing(null);read.refreshSilently();
      }catch(reason){
        if(reason instanceof DigitalRequestError&&!reason.resultUnknown&&reason.status!==null)
          throw new SubmissionRequestError(reason.message,reason.code,reason.status);
        throw reason;
      }finally{writing.current=false;}
    });
  };
  return <div id="quote-cost-reference" className="quotation-workbench-pricing" aria-label="本单报价测算">
    <p>成本合计 {current.unitCost===null?'待补齐':
      <span title={`精确成本 ${current.unitCost} 元/件`}>{previewDecimal(current.unitCost)} 元/件</span>}</p>
    <p>报价状态 {statusLabels[current.status]}</p>
    {(current.counts.returned+current.counts.resubmitted+current.counts.incomplete+current.counts.pendingCraftApproval)>0&&
      <p>待修改 {current.counts.returned} 项 · 待复核 {current.counts.resubmitted} 项 · 待补齐 {current.counts.incomplete} 项 · 待工艺审批 {current.counts.pendingCraftApproval} 项</p>}
    {current.reviews.length>0&&<ul aria-label="本报价退回明细">{current.reviews.map(review=>
      <li key={review.reviewId}>{rowNames.get(review.rowId)??'报价行'} · {review.field==='consumption'?'单件用量':'单价'} · {
        review.status==='returned'?'待修改':'待复核'} · {review.reason}</li>)}</ul>}
    {current.saved&&savedInput&&<p>已保存测算 · 报价 v{current.saved.version} · {savedSummary.label}{' '}
      <span title={`${savedSummary.label} ${savedInput.value}${savedSummary.unit}`}>
        {previewDecimal(savedInput.value)}{savedSummary.unit}</span> · 测算不等于客户确认</p>}
    <p>填任意一个，另一个自动算</p>
    <div className="budget-heading quotation-workbench-price-fields" onCompositionStart={()=>setComposing(true)} onCompositionEnd={()=>setComposing(false)}>
      <TextInput label="报价倍率（%）" value={fieldValue('multiplier',result?.multiplierPercent)} isDisabled={unavailable}
        onFocus={event=>setFocused({field:'multiplier',element:event.currentTarget})} onBlur={()=>setFocused(null)} onChange={value=>edit('multiplier',value)}/>
      <TextInput label="客户单件报价（元/件）" value={fieldValue('customerUnitPrice',result?.customerUnitPrice)} isDisabled={unavailable}
        onFocus={event=>setFocused({field:'customerUnitPrice',element:event.currentTarget})} onBlur={()=>setFocused(null)} onChange={value=>edit('customerUnitPrice',value)}/>
    </div>
    {costChanged&&<p>成本版本已更新，已按原输入重新测算。</p>}
    {error&&<p role="alert">{error}</p>}
    {result?.status==='zero_cost'&&<p>成本为零，报价倍率无法计算。</p>}
    {current.confirmation==='joint_release_ready'&&<Button label="保存报价测算" variant="secondary"
      isDisabled={unavailable||!editing||!result?.customerUnitPrice} onClick={save}/>}
    {recentSave&&!editing&&<p role="status">已保存报价测算，尚未记录客户确认。</p>}
    {feedback.notice&&<p role="alert">{feedback.notice}</p>}
    {feedback.uncertain&&<Button label="核对原报价测算保存结果" isDisabled={saving} onClick={()=>void feedback.retry()}/>}
    {current.confirmation==='awaiting_joint_release'?<p>当前仅供测算。新版报价确认将在工艺审批接通后开放。</p>:
     <Button label="用于本单客户确认" isDisabled={unavailable||current.status!=='awaiting_customer_confirmation'||!result?.customerUnitPrice}
      onClick={()=>{if(draft&&result?.customerUnitPrice)onAdopt(draft,result.customerUnitPrice);}}/>}
  </div>;
}
