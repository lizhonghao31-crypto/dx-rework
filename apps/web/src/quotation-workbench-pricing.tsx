import {useCallback,useState} from 'react';
import {Button} from '@astryxdesign/core/Button';
import {TextInput} from '@astryxdesign/core/TextInput';
import {calculateQuotationPricing,QuotationPricingInputSchema,QuotationWorkbenchPreviewSchema,type QuotationPricingInput}
  from '@dx-rework/contracts/digital-quotation';
import {digitalRequest} from './digital-production-api.js';
import {useForegroundRead} from './use-foreground-read.js';
import {useForegroundWait} from './foreground-loading.js';

const statusLabels={
  awaiting_correction:'待修改',awaiting_review:'待复核',incomplete:'待补齐',
  awaiting_craft_approval:'待工艺审批',awaiting_customer_confirmation:'报价资料已齐',
} as const;

function asMoney(value:string){
  const [whole,fraction='']=value.split('.');
  return `${whole}.${fraction.padEnd(2,'0')}`;
}

export function QuotationWorkbenchPricing({path,quoteId,version,refresh,disabled,rowNames}:{
  path:string;quoteId:string;version:number;refresh:number;disabled:boolean;rowNames:ReadonlyMap<string,string>;
}){
  const [editing,setEditing]=useState<QuotationPricingInput|null>(null);
  const [composing,setComposing]=useState(false);
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
  if(read.error)return <p role="alert">{read.error.message} <Button label="重新读取成本" onClick={read.retry}/></p>;
  if(!read.value)return null;

  const current=read.value, draft=editing??current.saved?.input??null;
  const result=draft&&!composing&&QuotationPricingInputSchema.safeParse(draft).success?calculateQuotationPricing(current.unitCost,draft):null;
  const rate=draft?.field==='multiplier'?draft.value:result?.multiplierPercent??'';
  const price=draft?.field==='customerUnitPrice'?draft.value:result?.customerUnitPrice?asMoney(result.customerUnitPrice):'';
  const error=draft&&!composing&&draft.value!==''&&!result?'请输入最多六位小数的非负数字'
    :result?.status==='price_out_of_range'?'按此倍率计算的客户单价超出金额范围':null;
  const unavailable=disabled||read.waiting;
  return <div id="quote-cost-reference" className="quotation-workbench-pricing" aria-label="本单报价测算">
    <p>成本合计 {current.unitCost===null?'待补齐':`${asMoney(current.unitCost)} 元/件`}</p>
    <p>报价状态 {statusLabels[current.status]}</p>
    {(current.counts.returned+current.counts.resubmitted+current.counts.incomplete+current.counts.pendingCraftApproval)>0&&
      <p>待修改 {current.counts.returned} 项 · 待复核 {current.counts.resubmitted} 项 · 待补齐 {current.counts.incomplete} 项 · 待工艺审批 {current.counts.pendingCraftApproval} 项</p>}
    {current.reviews.length>0&&<ul aria-label="本报价退回明细">{current.reviews.map(review=>
      <li key={review.reviewId}>{rowNames.get(review.rowId)??'报价行'} · {review.field==='consumption'?'单件用量':'单价'} · {
        review.status==='returned'?'待修改':'待复核'} · {review.reason}</li>)}</ul>}
    <p>填任意一个，另一个自动算</p>
    <div className="budget-heading quotation-workbench-price-fields" onCompositionStart={()=>setComposing(true)} onCompositionEnd={()=>setComposing(false)}>
      <TextInput label="报价倍率（%）" value={rate} isDisabled={unavailable} onChange={value=>setEditing({field:'multiplier',value})}/>
      <TextInput label="客户单件报价（元/件）" value={price} isDisabled={unavailable} onChange={value=>setEditing({field:'customerUnitPrice',value})}/>
    </div>
    {current.saved&&current.saved.version!==current.version&&<p>成本版本已更新，已按原输入重新测算。</p>}
    {error&&<p role="alert">{error}</p>}
    {result?.status==='zero_cost'&&<p>成本为零，报价倍率无法计算。</p>}
    <p>当前仅供测算。新版报价确认将在工艺审批接通后开放。</p>
  </div>;
}
