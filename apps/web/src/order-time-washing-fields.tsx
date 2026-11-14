import {orderTimeRule,type FrozenOrderTimePlan} from '@dx-rework/contracts/order-time-plan';
import {useEffect,useState} from 'react';
import {BulkWashingAdoptionSchema,bulkWashingLabels,type BulkWashingMode} from '@dx-rework/contracts/bulk-washing';
import type {OrderTimeCheckResult,OrderTimeWashingChanges} from '@dx-rework/contracts/order-time-requests';
import {digitalRequest} from './digital-production-api.js';
import {timeCalendars} from './order-time-settings-model.js';

type Row=NonNullable<OrderTimeCheckResult['washing']>[number];
type Person={id:string;displayName:string;roles:string[]};
type Draft={mode:BulkWashingMode;accounting:'additional'|'included_in_factory';washing:string;inspection:string;calendar:string;inspectionCalendar:string;logisticsId:string;inspectorId:string};
const from=(row:Row):Draft=>{const a=row.document?.arrangement;return {mode:a?.mode??'none',accounting:a&&a.mode!=='none'?a.accounting:'additional',washing:a&&a.mode!=='none'?String(a.washing.minutes/60):'',inspection:a&&a.mode!=='none'?String(a.inspection.minutes/60):'',calendar:a&&a.mode!=='none'?a.washing.calendar:'continuous',inspectionCalendar:a&&a.mode!=='none'?a.inspection.calendar:'continuous',logisticsId:row.document?.staff?.logisticsId??'',inspectorId:row.document?.staff?.inspectorId??''};};
/** Uses the existing order submission, not another save/approval endpoint. */
export function OrderTimeWashingFields({rows,plan,disabled,onChange,onInvalid}:{rows:Row[];plan:FrozenOrderTimePlan;disabled:boolean;onChange(value:OrderTimeWashingChanges):void;onInvalid(value:boolean):void}){
 const [drafts,setDrafts]=useState<Record<string,Draft>>({}),[people,setPeople]=useState<Person[]>([]),[error,setError]=useState('');
 useEffect(()=>{if(disabled)return;let live=true;void digitalRequest<Person[]>('access/candidates').then(value=>{if(live)setPeople(value);}).catch(reason=>{if(live)setError(reason instanceof Error?reason.message:'人员读取失败');});return()=>{live=false;};},[disabled]);
 const update=(row:Row,changes:Partial<Draft>)=>{
  if(changes.mode&&changes.mode!=='none'&&!row.document){
   const prefix=changes.mode==='factory'?'bulk_factory_washing':'bulk_return_washing',wash=orderTimeRule(plan,prefix)?.rule,inspection=orderTimeRule(plan,prefix+'_inspection')?.rule;
   changes={washing:wash?.minutes?String(wash.minutes/60):'',inspection:inspection?.minutes?String(inspection.minutes/60):'',calendar:wash?.calendar??'continuous',inspectionCalendar:inspection?.calendar??'continuous',...changes};
  }
  const next={...drafts,[row.lineId]:{...(drafts[row.lineId]??from(row)),...changes}};setDrafts(next);
  const result:OrderTimeWashingChanges=[];let invalid=false;
  for(const current of rows){const draft=next[current.lineId];if(!draft)continue;
   const old=current.document?.arrangement;
   const duration=(hours:string,kind:'washing'|'inspection')=>({minutes:hours.trim()?Number(hours)*60:null,calendar:kind==='washing'?draft.calendar:draft.inspectionCalendar,reminder:old&&old.mode!=='none'?old[kind].reminder:{enabled:true,percent:70}});
   const parsed=BulkWashingAdoptionSchema.safeParse({arrangement:draft.mode==='none'?{mode:'none'}:{mode:draft.mode,accounting:draft.mode==='after_receipt'?'additional':draft.accounting,reference:'order-time:'+current.lineId,revision:current.version+1,washing:duration(draft.washing,'washing'),inspection:duration(draft.inspection,'inspection')},...(draft.mode!=='none'?{staff:{logisticsId:draft.logisticsId,inspectorId:draft.inspectorId}}:{}),fee:current.document?.fee??{kind:'pending'},sourceRef:'本单时效调整'});
   if(!parsed.success)invalid=true;else result.push({lineId:current.lineId,expectedVersion:current.version,document:parsed.data});
  }
  onInvalid(invalid);if(!invalid)onChange(result);
 };
 return <details className="r5-time-washing"><summary>大货洗水</summary>{error&&<p role="alert">{error}</p>}{rows.map(row=>{
  const draft=drafts[row.lineId]??from(row);
  return <fieldset key={row.lineId} disabled={disabled}><legend>{row.label}</legend>
   <label>洗水方式<select value={draft.mode} onChange={event=>update(row,{mode:event.target.value as BulkWashingMode})}>{Object.entries(bulkWashingLabels).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
   {draft.mode!=='none'&&<>
    {draft.mode==='factory'&&<label>工厂用时<select value={draft.accounting} onChange={event=>update(row,{accounting:event.target.value as Draft['accounting']})}><option value="additional">洗水另外计时</option><option value="included_in_factory">已包含洗水和检查</option></select></label>}
    <label>洗水用时（小时）<input inputMode="decimal" value={draft.washing} onChange={event=>update(row,{washing:event.target.value})}/></label>
    <label>洗后检查（小时）<input inputMode="decimal" value={draft.inspection} onChange={event=>update(row,{inspection:event.target.value})}/></label>
    <label>哪些天计时<select value={draft.calendar} onChange={event=>update(row,{calendar:event.target.value})}>{Object.entries(timeCalendars).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
    <label>检查哪些天计时<select value={draft.inspectionCalendar} onChange={event=>update(row,{inspectionCalendar:event.target.value})}>{Object.entries(timeCalendars).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
    {(['logisticsId','inspectorId'] as const).map(key=><label key={key}>{key==='logisticsId'?'洗水跟单':'质检'}<select value={draft[key]} onChange={event=>update(row,{[key]:event.target.value})}><option value="">请选择</option>{people.filter(person=>person.roles.includes(key==='logisticsId'?'embroidery_washing_merchandiser':'quality_control')).map(person=><option key={person.id} value={person.id}>{person.displayName}</option>)}</select></label>)}
    <p>{row.document?.fee.kind==='budget_row'?'费用沿用已采用预算行':'费用待原预算补齐'}</p>
   </>}
  </fieldset>;
 })}</details>;
}
