import {useEffect,useState} from 'react';
import type {DevelopmentMakingBasis,DevelopmentMakingUpgrade} from '@dx-rework/contracts/digital-development';
export function makingUpgradeFromForm(form:FormData,basis:DevelopmentMakingBasis|undefined):DevelopmentMakingUpgrade|undefined{
 if(!basis?.needsUpgrade)return undefined;
 return {expectedDocumentVersion:basis.documentVersion,quantities:form.getAll('developmentMakingQuantity').map(value=>String(value).trim()===''?Number.NaN:Number(value))};
}
/** Explicit new-round input; legacy values are never guessed or written back. */
export function DevelopmentMakingUpgradeFields({basis,disabled=false}:{basis:DevelopmentMakingBasis|undefined;disabled?:boolean}){
 const [values,setValues]=useState<string[]>(basis?.sizes.map(()=>'')??[]);
 useEffect(()=>setValues(basis?.sizes.map(()=>'')??[]),[basis?.documentVersion,basis?.sizes.join('\u0000')]);
 if(!basis?.needsUpgrade)return null;
 const valid=values.length===basis.sizes.length&&values.every(value=>/^\d+$/.test(value)&&Number(value)<=100000),total=valid?values.reduce((sum,value)=>sum+Number(value),0):null;
 return <fieldset disabled={disabled} className="development-making-upgrade"><legend>填写新一轮各码制作数量</legend><p>历史资料未记录逐码数量。请按本次实际制作填写，0件不做，合计须为 {basis.quantity??'待核实'} 件；仅用于新轮，旧资料保持不变。</p><div className="pattern-fields">{basis.sizes.map((size,index)=><label key={index}>{size||`第${index+1}个尺码`}制作数量<input name="developmentMakingQuantity" aria-label={`${size||`第${index+1}个尺码`}新轮制作数量`} type="number" inputMode="numeric" min={0} max={100000} step={1} required value={values[index]??''} onChange={event=>setValues(current=>current.map((value,column)=>column===index?event.target.value:value))}/></label>)}</div><p role="status">{total===null?'请逐码填写0—100000整数，不会自动分配。':`已填合计 ${total} 件／本轮 ${basis.quantity??'待核实'} 件${total===basis.quantity?'':'，请核对后提交'}`}</p></fieldset>;
}
