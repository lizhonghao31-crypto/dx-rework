import {DIGITAL_SLA_PARAMETERS,DigitalSlaValueSchema,isSlaDurationMinutes,type DigitalSlaValue,type DigitalSlaValues} from '@dx-rework/contracts/digital-sla';
import {DevelopmentCycleValuesSchema,type DevelopmentCycleValues} from '@dx-rework/contracts/digital-development-technical';

export type SlaSettingErrors=Record<string,string>;
export type SlaDraftSnapshot<T>={version:number;current:T;values:T;errors:SlaSettingErrors;publishedVersion:number|null;readOnly:boolean;resultUnknown?:boolean;draftResultUnknown?:boolean};
export type SlaInputUnit='minutes'|'hours'|'days-duration'|'days'|'percent';
export const slaUnitFactor=(unit:SlaInputUnit)=>unit==='hours'?60:unit==='days-duration'?1440:1;
export const slaScalar=(value:DigitalSlaValue)=>'minutes'in value?value.minutes:'days'in value?value.days:'percent'in value?value.percent:0;
export const slaDefaultUnit=(value:DigitalSlaValue):SlaInputUnit=>'minutes'in value?value.kind==='buffer'||value.kind==='included'||value.minutes<1?'minutes':'hours':'days'in value?'days':'percent';
export const slaWithScalar=(value:DigitalSlaValue,number:number):DigitalSlaValue=>'minutes'in value?{...value,minutes:number}:'days'in value?{...value,days:number}:'percent'in value?{...value,percent:number}:value;
/** Raw text is retained separately. Empty/intermediate input is never a valid numeric zero. */
export function slaInputValue(raw:string,unit:SlaInputUnit,value:DigitalSlaValue):{value:DigitalSlaValue|null;error:string|null}{
 if(!raw.trim())return {value:null,error:'请填写本字段数值，空白不按0计算'};
 if(!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(raw.trim()))return {value:null,error:'数值尚未完整，请继续输入'};
 const number=Number(raw)*slaUnitFactor(unit);
 if(!Number.isFinite(number))return {value:null,error:'数值超出可用范围'};
 const next=slaWithScalar(value,number),parsed=DigitalSlaValueSchema.safeParse(next);
 if(!parsed.success)return {value:null,error:value.kind==='buffer'?'缓冲须为0或正整数分钟':value.kind==='ratio'?'临期比例须为1至99的整数':value.kind==='offset'?'提前天数须为0至365的整数':'时长须为正数、最多365天，且可准确表示到毫秒'};
 return {value:parsed.data,error:null};
}
export function readableSlaMinutes(minutes:number):string{
 if(!Number.isFinite(minutes)||minutes<0)return '时长尚不能确定';
 let remaining=Math.round(minutes*60000);if(!remaining)return '0分钟';
 const parts:string[]=[];for(const [size,label]of [[86400000,'天'],[3600000,'小时'],[60000,'分钟'],[1000,'秒'],[1,'毫秒']] as const){const count=Math.floor(remaining/size);if(count){parts.push(`${count}${label}`);remaining-=count*size;}}
 return parts.join('');
}
export const readableSlaValue=(value:DigitalSlaValue)=>{
 const label='minutes'in value?`${readableSlaMinutes(value.minutes)}${value.kind==='included'?'（计入父窗口）':value.kind==='estimate'?'（预计）':''}`:'days'in value?`提前${value.days}天`:'percent'in value?`${value.percent}%`:value.kind==='order_date'?'按原约定日期':'不设独立截止';
 return label+('notificationEnabled'in value&&typeof value.notificationEnabled==='boolean'?value.notificationEnabled?'（提醒开启）':'（提醒关闭）':'');
};
export function slaDraftErrors(values:DigitalSlaValues):SlaSettingErrors{
 const errors:SlaSettingErrors={};
 for(const p of DIGITAL_SLA_PARAMETERS){const value=values[p.key];if(!value||value.kind!==p.defaultValue.kind||!DigitalSlaValueSchema.safeParse(value).success)errors[p.key]=`${p.label}的数值、类型或单位不合法`;}
 for(const parent of DIGITAL_SLA_PARAMETERS.filter(p=>p.defaultValue.kind==='duration')){
  const value=values[parent.key];if(value?.kind!=='duration'||!isSlaDurationMinutes(value.minutes))continue;
  const children=DIGITAL_SLA_PARAMETERS.filter(p=>p.includedIn?.includes(parent.key));const used=children.reduce((sum,c)=>{const v=values[c.key];return sum+(v?.kind==='included'?v.minutes:0);},0);
  if(used>value.minutes){const reason=`${parent.label}内含目标合计${readableSlaMinutes(used)}，超过父窗口${readableSlaMinutes(value.minutes)}`;errors[parent.key]=reason;for(const child of children)errors[child.key]=reason;}
 }
 return errors;
}
export function developmentDraftErrors(values:DevelopmentCycleValues):SlaSettingErrors{
 const result=DevelopmentCycleValuesSchema.safeParse(values);if(result.success)return {};
 const errors:SlaSettingErrors={};for(const issue of result.error.issues){const key=typeof issue.path[0]==='string'?issue.path[0]:'urgentDays';errors[key]=issue.message.includes('加急')?'批准加急周期不能长于普通周期':'请填写该字段允许范围内的正整数';}return errors;
}
export const sameSlaValues=(a:DigitalSlaValues,b:DigitalSlaValues)=>DIGITAL_SLA_PARAMETERS.every(p=>JSON.stringify(a[p.key])===JSON.stringify(b[p.key]));
