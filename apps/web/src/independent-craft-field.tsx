import {useEffect,useState} from 'react';
import {CheckboxInput} from '@astryxdesign/core/CheckboxInput';
import {Selector} from '@astryxdesign/core/Selector';
import {DevelopmentEntryAction} from './development-entry-controls.js';
import {craftChoiceLabel,craftLegacyLabel,craftStepIdentity,craftStepLabel,type CraftStepChoice,type SpecialCraftVersion} from '@dx-rework/contracts/digital-craft';
import {digitalRequest} from './digital-production-api.js';
import './independent-craft-field.css';
type Props={label:string;entryControls?:boolean;explicitOrder?:boolean;orderConfirmed?:boolean;firstControlId?:string|undefined;value:ReturnType<typeof craftLegacyLabel>;steps?:CraftStepChoice[]|undefined;readonly:boolean;disabled:boolean;onChange:(value:Props['value'],steps:CraftStepChoice[],orderConfirmed?:boolean)=>void};
const LegacyAction=({children,...props}:React.ComponentPropsWithoutRef<'button'>)=><button {...props} className="dx-button dx-button--secondary">{children}</button>;
export function IndependentCraftField({label,entryControls=false,explicitOrder=false,orderConfirmed=false,firstControlId,value,steps,readonly,disabled,onChange}:Props){
 const [library,setLibrary]=useState<{enabled:boolean;items:SpecialCraftVersion[]}|null>(null),[error,setError]=useState('');
 useEffect(()=>{if(readonly)return;const controller=new AbortController();void digitalRequest<{enabled:boolean;items:SpecialCraftVersion[]}>('special-craft-library/choices','GET',undefined,undefined,{signal:controller.signal}).then(setLibrary).catch(reason=>{if(reason.name!=='AbortError')setError(reason.message);});return()=>controller.abort();},[readonly]);
 const selected:CraftStepChoice[]=steps??(value==='无'?[]:value==='特殊工艺'?[]:value==='印花'?[{craftKind:'printing',sequence:1}]:value==='绣花'?[{craftKind:'embroidery',sequence:1}]:[{craftKind:'embroidery',sequence:1},{craftKind:'printing',sequence:2}]);
 const identity=selected.map(craftStepIdentity).sort().join('|');
 const [stations,setStations]=useState<{key:string;selected:string[]}>({key:'',selected:[]});
 const choices=orderConfirmed?selected.map(craftStepIdentity):stations.key===identity?stations.selected:[];
 const write=(items:CraftStepChoice[],confirmed=false)=>{
  const next=items.map((item,index)=>({...item,sequence:index+1}));
  if(!confirmed)setStations({key:'',selected:[]});
  onChange(craftLegacyLabel(next),next,explicitOrder&&(confirmed||next.length<2));
 };
 const chooseStation=(index:number,value:string)=>{
  if(!selected.some(item=>craftStepIdentity(item)===value))return;
  const next=Array.from({length:selected.length},(_,at)=>choices[at]??'');
  const previous=next.indexOf(value);
  if(previous>=0)next[previous]=next[index]??'';
  next[index]=value;
  setStations({key:identity,selected:next});
  if(next.every(Boolean))write(next.map(key=>selected.find(item=>craftStepIdentity(item)===key)!),true);
 };
 if(readonly)return <label>{label}<span className="dx-doc-readonly">{steps?craftChoiceLabel(steps):value}</span></label>;
 const special=selected.some(step=>step.craftKind==='special');
 const addSpecial=(id:string)=>{
  const item=library?.items.find(value=>value.id===id);
  if(item)write([...selected,{craftKind:'special',sequence:selected.length+1,specialCraft:item}]);
 };
 const orders=[{value:'embroidery',label:'绣花 → 印花'},{value:'printing',label:'印花 → 绣花'}];
 const reorder=(first:string)=>write([...selected].sort((a,b)=>a.craftKind===first?-1:b.craftKind===first?1:0));
 const move=(index:number,offset:number)=>{
  const next=[...selected],other=index+offset;
  [next[other],next[index]]=[next[index]!,next[other]!];write(next);
 };
 const Action=entryControls?DevelopmentEntryAction:LegacyAction;
 return <fieldset disabled={disabled} className="development-craft-choice" data-explicit-order={explicitOrder} data-special={special||Boolean(library?.enabled)}><legend>{label}</legend>
  <div className="development-craft-choice-main">{(['embroidery','printing'] as const).map((kind,index)=>{
   const text=kind==='embroidery'?'绣花':'印花',id=index===0?firstControlId:undefined;
   const value=selected.some(step=>step.craftKind===kind),change=(checked:boolean)=>write(checked
    ?[...selected,{craftKind:kind,sequence:selected.length+1}]:selected.filter(step=>step.craftKind!==kind));
   return entryControls?<CheckboxInput key={kind} {...(id?{id}:{})} label={text} value={value} isDisabled={disabled} onChange={change}/>
    :<label key={kind}><input id={id} type="checkbox" checked={value} onChange={event=>change(event.target.checked)}/>{text}</label>;
  })}
  {library?.enabled&&(entryControls?<Selector label={explicitOrder?'特殊工艺':`${label}特殊工艺`} size="sm" placeholder="选择具体工艺" value="" isDisabled={disabled}
    options={library.items.filter(item=>!selected.some(step=>step.specialCraft?.id===item.id)).map(item=>({value:item.id,label:item.definition.name}))}
    onChange={addSpecial}/>
    :<label>特殊工艺<select aria-label={`${label}特殊工艺`} value="" onChange={event=>addSpecial(event.target.value)}>
     <option value="">选择具体工艺</option>{library.items.filter(item=>!selected.some(step=>step.specialCraft?.id===item.id)).map(item=><option key={item.id} value={item.id}>{item.definition.name}</option>)}
    </select></label>)}
  {error&&special&&<span role="alert">工艺库读取失败，原选择已保留：{error}</span>}
  {explicitOrder&&selected.filter(item=>item.craftKind==='special').map(item=><Action key={craftStepIdentity(item)} type="button" disabled={disabled}
   aria-label={`移除${craftStepLabel(item)}`} onClick={()=>write(selected.filter(step=>craftStepIdentity(step)!==craftStepIdentity(item)))}>{`移除${craftStepLabel(item)}`}</Action>)}
  </div>
  {explicitOrder&&selected.length>=2&&<div className="development-craft-stations" aria-label="工艺顺序">
   <strong>工艺顺序 *</strong>
   {selected.map((_,index)=><Selector key={index} label={`第 ${index+1} 站工艺`} size="sm" placeholder="请选择" isRequired
    value={choices[index]??''} options={selected.map(item=>({value:craftStepIdentity(item),label:craftStepLabel(item)}))}
    isDisabled={disabled} onChange={value=>chooseStation(index,value)}/>)}
   {!orderConfirmed&&<small>请按实际加工顺序选择每一站。</small>}
  </div>}
  {!explicitOrder&&selected.length===2&&!special&&(entryControls?<Selector label={`${label}先后顺序`} size="sm" value={steps?.length===2?steps[0]!.craftKind:''}
    placeholder="请选择实际顺序" isDisabled={disabled} options={orders} onChange={reorder}/>
    :<label>先后顺序<select aria-label={`${label}先后顺序`} value={steps?.length===2?steps[0]!.craftKind:''} onChange={event=>reorder(event.target.value)}>
     <option value="" disabled>请选择实际顺序</option>{orders.map(option=><option key={option.value} value={option.value}>{option.label}</option>)}
    </select></label>)}
  {!explicitOrder&&special&&<ol aria-label={`${label}实际顺序`}>{selected.map((step,index)=><li key={craftStepIdentity(step)}><span>{craftStepLabel(step)}</span>
    <Action type="button" disabled={disabled||index===0} aria-label={`${craftStepLabel(step)}前移`} onClick={()=>move(index,-1)}>前移</Action>
    <Action type="button" disabled={disabled||index===selected.length-1} aria-label={`${craftStepLabel(step)}后移`} onClick={()=>move(index,1)}>后移</Action>
    {step.craftKind==='special'&&<Action type="button" disabled={disabled} onClick={()=>write(selected.filter(item=>craftStepIdentity(item)!==craftStepIdentity(step)))}>移除</Action>}
   </li>)}</ol>}
 </fieldset>;
}
