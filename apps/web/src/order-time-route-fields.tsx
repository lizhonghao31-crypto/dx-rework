import {craftChoiceLabel} from '@dx-rework/contracts/digital-craft';
import type {OrderTimeCalculation} from '@dx-rework/contracts/order-time-settings';
type Route=Pick<OrderTimeCalculation,'development'|'bulk'>;
export const initialTimeRoute:Route={development:{enabled:true,craftSteps:[],washing:'免洗',accessories:false},bulk:{craftSteps:[],preshrink:false}};
function Craft({label,steps,onChange}:{label:string;steps:Route['bulk']['craftSteps'];onChange(value:Route['bulk']['craftSteps']):void}){
 return <div className="r5-craft-choice"><span>{label}</span>{(['embroidery','printing'] as const).map(kind=><label key={kind}><input type="checkbox" checked={steps.some(s=>s.craftKind===kind)} onChange={e=>onChange((e.target.checked?[...steps,{craftKind:kind,sequence:steps.length+1}]:steps.filter(s=>s.craftKind!==kind)).map((s,i)=>({...s,sequence:i+1})))}/>{kind==='embroidery'?'绣花':'印花'}</label>)}{steps.length===2&&<button type="button" className="r5-link" onClick={()=>onChange([...steps].reverse().map((s,i)=>({...s,sequence:i+1})))}>{craftChoiceLabel(steps)} ⇄</button>}</div>;
}
export function OrderTimeRouteFields({value,onChange}:{value:Route;onChange(value:Route):void}){
 return <details className="r5-route-fields"><summary>适用工艺：{value.bulk.craftSteps.length?craftChoiceLabel(value.bulk.craftSteps):'无二次工艺'}</summary>
  <div><label><input type="checkbox" checked={value.development.enabled} onChange={e=>onChange({...value,development:{...value.development,enabled:e.target.checked}})}/>包含开发流程</label>
   {value.development.enabled&&<><Craft label="开发工艺" steps={value.development.craftSteps} onChange={craftSteps=>onChange({...value,development:{...value.development,craftSteps}})}/><label>洗水<select value={value.development.washing} onChange={e=>onChange({...value,development:{...value.development,washing:e.target.value as Route['development']['washing']}})}><option>免洗</option><option>内洗</option><option>外洗</option></select></label><label><input type="checkbox" checked={value.development.accessories} onChange={e=>onChange({...value,development:{...value.development,accessories:e.target.checked}})}/>本轮需要辅料</label></>}
   <Craft label="大货工艺" steps={value.bulk.craftSteps} onChange={craftSteps=>onChange({...value,bulk:{...value.bulk,craftSteps}})}/><label><input type="checkbox" checked={value.bulk.preshrink} onChange={e=>onChange({...value,bulk:{...value.bulk,preshrink:e.target.checked}})}/>需要预缩</label>
  </div>
 </details>;
}
