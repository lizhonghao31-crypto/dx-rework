import {craftLegacyLabel} from '@dx-rework/contracts/digital-craft';
import type {OrderTimeProductionRoute} from '@dx-rework/contracts/order-time-requests';
import {IndependentCraftField} from './independent-craft-field.js';

/** Future production scope is an explicit business choice. Empty is confirmed
 * no-craft; null is undecided and cannot silently become a feasible route. */
export function OrderTimeProductionRoute({value,disabled,onChange}:{value:OrderTimeProductionRoute|undefined;disabled:boolean;onChange(value:OrderTimeProductionRoute):void}){
 return <section className="development-create-card" aria-label="大货适用工艺"><h3>大货适用工艺</h3>
  <label>大货工艺<select aria-label="大货工艺是否确定" disabled={disabled} value={value?.craftSteps===null||!value?'unknown':'known'} onChange={event=>onChange({preshrink:value?.preshrink??null,craftSteps:event.target.value==='known'?[]:null})}><option value="unknown">尚未确定</option><option value="known">已确定，填写本单工艺</option></select></label>
  {value?.craftSteps&&<IndependentCraftField label="大货印花与绣花" value={craftLegacyLabel(value.craftSteps)} steps={value.craftSteps} readonly={false} disabled={disabled} onChange={(_label,craftSteps)=>onChange({...value,craftSteps})}/>}
  <label>大货是否预缩<select aria-label="大货是否预缩" disabled={disabled} value={value?.preshrink===true?'yes':value?.preshrink===false?'no':''} onChange={event=>onChange({craftSteps:value?.craftSteps??null,preshrink:event.target.value===''?null:event.target.value==='yes'})}><option value="">尚未确定</option><option value="yes">需要预缩</option><option value="no">无需预缩</option></select></label>
 </section>;
}
