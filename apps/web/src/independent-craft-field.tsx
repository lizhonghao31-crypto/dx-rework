import {craftChoiceLabel,craftLegacyLabel,type CraftStepChoice} from '@dx-rework/contracts/digital-craft';
import './independent-craft-field.css';

type Props={label:string;value:'无'|'印花'|'绣花'|'印绣花';steps?:CraftStepChoice[]|undefined;readonly:boolean;disabled:boolean;onChange:(value:Props['value'],steps:CraftStepChoice[])=>void};
export function IndependentCraftField({label,value,steps,readonly,disabled,onChange}:Props){
 const selected:CraftStepChoice['craftKind'][]=steps?steps.map(step=>step.craftKind):value==='无'?[]:value==='印花'?['printing']:value==='绣花'?['embroidery']:['embroidery','printing'];
 const write=(kinds:CraftStepChoice['craftKind'][])=>{const next=kinds.map((craftKind,index)=>({craftKind,sequence:index+1}));onChange(craftLegacyLabel(next),next);};
 if(readonly)return <label>{label}<span className="dx-doc-readonly">{steps?craftChoiceLabel(steps):value}</span></label>;
 return <fieldset disabled={disabled} className="development-craft-choice"><legend>{label}</legend>
  {(['embroidery','printing'] as const).map(kind=><label key={kind}><input type="checkbox" checked={selected.includes(kind)} onChange={event=>write(event.target.checked?[...selected,kind]:selected.filter(value=>value!==kind))}/>{kind==='embroidery'?'绣花':'印花'}</label>)}
  {selected.length===2&&<label>先后顺序<select aria-label={`${label}先后顺序`} value={steps?.length===2?steps[0]!.craftKind:''} onChange={event=>write(event.target.value==='embroidery'?['embroidery','printing']:['printing','embroidery'])}>
   <option value="" disabled>请选择实际顺序</option><option value="embroidery">绣花 → 印花</option><option value="printing">印花 → 绣花</option>
  </select></label>}
 </fieldset>;
}
