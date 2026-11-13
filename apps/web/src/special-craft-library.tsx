import {useEffect,useRef,useState} from 'react';
import {SpecialCraftDefinitionSchema,type SpecialCraftDefinition,type SpecialCraftVersion} from '@dx-rework/contracts/digital-craft';
import {digitalRequest,DigitalRequestError} from './digital-production-api.js';
import {createClientRequestId} from './client-request-id.js';
import {useDigitalDetailNavigationGuard} from './use-digital-detail-navigation-guard.js';
import {timeCalendars,timeText} from './order-time-settings-model.js';
const empty=():SpecialCraftDefinition=>({name:'',enabled:true,development:{minutes:null,calendar:null,reminder:{enabled:true,percent:70}},bulk:{minutes:null,calendar:null,reminder:{enabled:true,percent:70}}});
type Edit={id:string|null;version:number;original:SpecialCraftDefinition;value:SpecialCraftDefinition};
type Operation={body:{id:string|null;expectedVersion:number;definition:SpecialCraftDefinition};key:string};
export function SpecialCraftLibrary({readOnly,onAuthorityChanged}:{readOnly:boolean;onAuthorityChanged():void}){
 const [items,setItems]=useState<SpecialCraftVersion[]|null>(null),[edit,setEdit]=useState<Edit|null>(null),[busy,setBusy]=useState(false),[uncertain,setUncertain]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const operation=useRef<Operation|null>(null),active=useRef(false),live=useRef(true);
 const dirty=edit!==null&&JSON.stringify(edit.value)!==JSON.stringify(edit.original);
 useDigitalDetailNavigationGuard(dirty||uncertain,busy,active,'特殊工艺设置尚未保存，确认离开？');
 const authority=(reason:unknown)=>{if(reason instanceof DigitalRequestError&&[401,403].includes(reason.status??0))onAuthorityChanged();};
 const read=async(signal?:AbortSignal)=>{const result=await digitalRequest<{items:SpecialCraftVersion[]}>('special-craft-library','GET',undefined,undefined,signal?{signal}:undefined);if(live.current)setItems(result.items);};
 useEffect(()=>{live.current=true;const controller=new AbortController();void read(controller.signal).catch(reason=>{if(live.current&&reason.name!=='AbortError'){authority(reason);setError(reason.message);}});return()=>{live.current=false;controller.abort();};},[]);
 const save=async()=>{
  if(readOnly||active.current||!edit)return;
  const parsed=SpecialCraftDefinitionSchema.safeParse(edit.value);if(!parsed.success){setError('请检查名称、用时和提醒比例。');return;}
  const pending=operation.current??{body:{id:edit.id,expectedVersion:edit.version,definition:parsed.data},key:createClientRequestId()};
  operation.current=pending;active.current=true;setBusy(true);setError('');
  try{
   const result=await digitalRequest<SpecialCraftVersion>('special-craft-library','POST',pending.body,pending.key);
   if(!result.id||result.version!==pending.body.expectedVersion+1||!SpecialCraftDefinitionSchema.safeParse(result.definition).success)throw new DigitalRequestError('保存回执不完整，请核对上次操作。',null);
   operation.current=null;if(live.current){setUncertain(false);setEdit(null);setNotice('已保存，已生效订单保持原设置。');}
   try{await read();}catch(reason){authority(reason);if(live.current)setError('已保存，列表读取失败，请刷新。');}
  }catch(reason){authority(reason);if(live.current){setError((reason as Error).message);setUncertain(reason instanceof DigitalRequestError&&reason.resultUnknown);}if(!(reason instanceof DigitalRequestError&&reason.resultUnknown))operation.current=null;
  }finally{active.current=false;if(live.current)setBusy(false);}
 };
 const disabled=readOnly||busy||uncertain;
 const change=(value:SpecialCraftDefinition)=>{if(edit)setEdit({...edit,value});setError('');};
 const open=(item?:SpecialCraftVersion)=>{const value=structuredClone(item?.definition??empty());setEdit({id:item?.id??null,version:item?.version??0,original:structuredClone(value),value});setError('');setNotice('');};
 return <section className="r5-standard-editor r5-special-library" aria-label="特殊工艺库">
  <div className="r5-current-settings"><h2>特殊工艺库</h2><button type="button" className="r5-link" disabled={busy||uncertain} onClick={()=>void read().catch(reason=>{authority(reason);setError(reason.message);})}>刷新</button>{!readOnly&&<button type="button" className="r5-button" disabled={busy||edit!==null} onClick={()=>open()}>新增工艺</button>}</div>
  {error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
  {uncertain&&<p role="status">上次保存结果待核对，原输入已保留。<button type="button" className="r5-button" disabled={busy} onClick={()=>void save()}>核对保存结果</button></p>}
  <div className="r5-table-scroll"><table><thead><tr><th>工艺</th><th>开发样板用时</th><th>大货用时</th><th>状态</th><th>操作</th></tr></thead><tbody>
   {items?.map(item=><tr key={item.id}><th>{item.definition.name}</th><td>{timeText(item.definition.development.minutes)}</td><td>{timeText(item.definition.bulk.minutes)}</td><td>{item.definition.enabled?'启用':'停用'}</td><td><button type="button" className="r5-link" disabled={busy||edit!==null} onClick={()=>open(item)}>{readOnly?'查看':'调整'}</button></td></tr>)}
   {items?.length===0&&<tr><td colSpan={5}>还没有特殊工艺。</td></tr>}
  </tbody></table></div>{items===null&&!error&&<p role="status">正在读取工艺库…</p>}
  {edit&&<section className="r5-node-editor" aria-label="特殊工艺设置"><h3>{edit.id?'调整工艺':'新增工艺'}</h3>
   <label>工艺名称<input maxLength={80} value={edit.value.name} disabled={disabled} onChange={e=>change({...edit.value,name:e.target.value})}/></label>
   <label><input type="checkbox" checked={edit.value.enabled} disabled={disabled} onChange={e=>change({...edit.value,enabled:e.target.checked})}/>启用</label>
   <div className="r5-special-stages">{(['development','bulk'] as const).map(stage=>{const value=edit.value[stage],label=stage==='development'?'开发样板':'大货';const update=(next:typeof value)=>change({...edit.value,[stage]:next});return <fieldset key={stage} disabled={disabled}><legend>{label}</legend>
    <label>允许用时<input aria-label={label+'允许用时（小时）'} type="number" min={0} step="any" value={value.minutes===null?'':value.minutes/60} onChange={e=>update({...value,minutes:e.target.value===''?null:Number(e.target.value)*60})}/>小时</label>
    <label>哪些天计时<select aria-label={label+'哪些天计时'} value={value.calendar??''} onChange={e=>update({...value,calendar:(e.target.value||null) as typeof value.calendar})}><option value="">还没设置</option>{Object.entries(timeCalendars).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
    <label><input type="checkbox" checked={value.reminder.enabled} onChange={e=>update({...value,reminder:{...value.reminder,enabled:e.target.checked}})}/>提醒</label>
    {value.reminder.enabled&&<label>用掉多少时间时提醒<input type="number" min={1} max={99} value={value.reminder.percent} onChange={e=>update({...value,reminder:{...value.reminder,percent:Number(e.target.value)}})}/>%</label>}
   </fieldset>;})}</div>
   <footer><button type="button" className="r5-button" disabled={busy||uncertain} onClick={()=>setEdit(null)}>{readOnly?'关闭':'取消'}</button>{!readOnly&&<button type="button" className="r5-button r5-primary" disabled={disabled||!SpecialCraftDefinitionSchema.safeParse(edit.value).success} onClick={()=>void save()}>{busy?'正在保存…':'保存'}</button>}</footer>
  </section>}
 </section>;
}
