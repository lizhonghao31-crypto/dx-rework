import {useState} from 'react';
import type {DigitalSlaValue,DigitalSlaValues} from '@dx-rework/contracts/digital-sla';
import {slaInputValue,slaScalar} from './sla-settings-draft.js';

function CommonField({field,label,value,disabled,onInput}:{field:string;label:string;value:DigitalSlaValue;disabled:boolean;onInput(key:string,value:DigitalSlaValue|null,error:string|null):void}){
 const [raw,setRaw]=useState(()=>String(slaScalar(value))),[error,setError]=useState<string|null>(null);
 return <label>{label}<span><input aria-label={label} type="text" inputMode="decimal" disabled={disabled} aria-invalid={Boolean(error)} value={raw} onChange={event=>{setRaw(event.target.value);const result=slaInputValue(event.target.value,value.kind==='ratio'?'percent':'minutes',value);setError(result.error);onInput(field,result.value,result.error);}}/>{value.kind==='ratio'?'%':'分钟'}</span>{error&&<small role="alert">{error}</small>}</label>;
}
export function SlaCommonFields({values,disabled,onInput}:{values:DigitalSlaValues;disabled:boolean;onInput(key:string,value:DigitalSlaValue|null,error:string|null):void}){
 return <details className="sla-common-fields"><summary>共用提醒与阶段预留</summary><CommonField field="warning_ratio" label="所有节点共用临期阈值" value={values.warning_ratio!} disabled={disabled} onInput={onInput}/><CommonField field="stage_buffer" label="每阶段统一预留" value={values.stage_buffer!} disabled={disabled} onInput={onInput}/></details>;
}
