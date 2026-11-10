import {useEffect,useState} from 'react';
import {DevelopmentCycleValuesSchema,type DevelopmentCycleValues} from '@dx-rework/contracts/digital-development-technical';
const rows=[['normalDays','普通开发周期','天'],['urgentDays','批准加急周期','天'],['sizeReviewHours','尺寸复核','小时'],['externalWashDays','外洗周期','天']] as const;
export function SlaCalculationCycleInputs({value,onChange,onValidity}:{value:DevelopmentCycleValues;onChange(value:DevelopmentCycleValues):void;onValidity(valid:boolean):void}){
 const [raw,setRaw]=useState<Record<string,string>>({}),[invalid,setInvalid]=useState<Record<string,boolean>>({}),valid=DevelopmentCycleValuesSchema.safeParse(value).success&&!Object.values(invalid).some(Boolean);
 useEffect(()=>onValidity(valid),[valid,onValidity]);
 return <div className="sla-calculation-condition-grid" aria-label="本次演算开发周期">{rows.map(([key,label,unit])=><label key={key}>{label}<input type="text" inputMode="numeric" aria-label={'演算'+label} value={raw[key]??String(value[key])} onChange={e=>{const text=e.target.value,good=/^[1-9]\d*$/.test(text)&&Number(text)<=8760;setRaw(previous=>({...previous,[key]:text}));setInvalid(previous=>({...previous,[key]:!good}));if(good)onChange({...value,[key]:Number(text)});}}/>{unit}</label>)}{!valid&&<p role="alert">请填写有效开发周期，加急周期不能超过普通周期。</p>}</div>;
}
