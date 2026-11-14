import {useEffect,useState} from 'react';
import {craftChoiceLabel,craftLegacyLabel,craftStepIdentity,craftStepLabel,type CraftStepChoice,type SpecialCraftVersion} from '@dx-rework/contracts/digital-craft';
import {digitalRequest} from './digital-production-api.js';
import './independent-craft-field.css';
type Props={label:string;value:ReturnType<typeof craftLegacyLabel>;steps?:CraftStepChoice[]|undefined;readonly:boolean;disabled:boolean;onChange:(value:Props['value'],steps:CraftStepChoice[])=>void};
export function IndependentCraftField({label,value,steps,readonly,disabled,onChange}:Props){
 const [library,setLibrary]=useState<{enabled:boolean;items:SpecialCraftVersion[]}|null>(null),[error,setError]=useState('');
 useEffect(()=>{if(readonly)return;const controller=new AbortController();void digitalRequest<{enabled:boolean;items:SpecialCraftVersion[]}>('special-craft-library/choices','GET',undefined,undefined,{signal:controller.signal}).then(setLibrary).catch(reason=>{if(reason.name!=='AbortError')setError(reason.message);});return()=>controller.abort();},[readonly]);
 const selected:CraftStepChoice[]=steps??(value==='无'?[]:value==='特殊工艺'?[]:value==='印花'?[{craftKind:'printing',sequence:1}]:value==='绣花'?[{craftKind:'embroidery',sequence:1}]:[{craftKind:'embroidery',sequence:1},{craftKind:'printing',sequence:2}]);
 const write=(items:CraftStepChoice[])=>{const next=items.map((item,index)=>({...item,sequence:index+1}));onChange(craftLegacyLabel(next),next);};
 if(readonly)return <label>{label}<span className="dx-doc-readonly">{steps?craftChoiceLabel(steps):value}</span></label>;
 const special=selected.some(step=>step.craftKind==='special');
 return <fieldset disabled={disabled} className="development-craft-choice" data-special={special||Boolean(library?.enabled)}><legend>{label}</legend>
  {(['embroidery','printing'] as const).map(kind=><label key={kind}><input type="checkbox" checked={selected.some(step=>step.craftKind===kind)} onChange={event=>write(event.target.checked?[...selected,{craftKind:kind,sequence:selected.length+1}]:selected.filter(step=>step.craftKind!==kind))}/>{kind==='embroidery'?'绣花':'印花'}</label>)}
  {library?.enabled&&<label>特殊工艺<select aria-label={`${label}特殊工艺`} value="" onChange={event=>{const item=library.items.find(item=>item.id===event.target.value);if(item)write([...selected,{craftKind:'special',sequence:selected.length+1,specialCraft:item}]);}}><option value="">选择具体工艺</option>{library.items.filter(item=>!selected.some(step=>step.specialCraft?.id===item.id)).map(item=><option key={item.id} value={item.id}>{item.definition.name}</option>)}</select></label>}
  {error&&special&&<span role="alert">工艺库读取失败，原选择已保留：{error}</span>}
  {selected.length===2&&!special&&<label>先后顺序<select aria-label={`${label}先后顺序`} value={steps?.length===2?steps[0]!.craftKind:''} onChange={event=>write([...selected].sort((a,b)=>a.craftKind===event.target.value?-1:b.craftKind===event.target.value?1:0))}>
   <option value="" disabled>请选择实际顺序</option><option value="embroidery">绣花 → 印花</option><option value="printing">印花 → 绣花</option>
  </select></label>}
  {special&&<ol aria-label={`${label}实际顺序`}>{selected.map((step,index)=><li key={craftStepIdentity(step)}><span>{craftStepLabel(step)}</span><button type="button" className="dx-button dx-button--secondary" disabled={disabled||index===0} aria-label={`${craftStepLabel(step)}前移`} onClick={()=>{const next=[...selected];[next[index-1],next[index]]=[next[index]!,next[index-1]!];write(next);}}>前移</button><button type="button" className="dx-button dx-button--secondary" disabled={disabled||index===selected.length-1} aria-label={`${craftStepLabel(step)}后移`} onClick={()=>{const next=[...selected];[next[index],next[index+1]]=[next[index+1]!,next[index]!];write(next);}}>后移</button>{step.craftKind==='special'&&<button type="button" className="dx-button dx-button--secondary" onClick={()=>write(selected.filter(item=>craftStepIdentity(item)!==craftStepIdentity(step)))}>移除</button>}</li>)}</ol>}
 </fieldset>;
}
