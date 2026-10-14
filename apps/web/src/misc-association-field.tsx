import {useEffect,useState} from 'react';
import {MiscAssociationOptionsSchema,type MiscAssociationSnapshot} from '@dx-rework/contracts/pattern-orders';
import {SearchableSelect} from './search-select.js';
import {patternRequest} from './pattern-order-client.js';
export function MiscAssociationField({value,disabled,onChange,onUnmatchedSearch}:{value:MiscAssociationSnapshot|null;disabled:boolean;onChange:(value:MiscAssociationSnapshot|null)=>void;onUnmatchedSearch:()=>void}){
 const [query,setQuery]=useState(''),[options,setOptions]=useState<MiscAssociationSnapshot[]>([]),[error,setError]=useState(''),[loading,setLoading]=useState(false);
 useEffect(()=>{
  const abort=new AbortController(),timer=setTimeout(()=>{
   setLoading(true);setError('');
   void patternRequest(`misc-associations?${new URLSearchParams({q:query.trim()})}`,MiscAssociationOptionsSchema,{signal:abort.signal}).then(setOptions).catch(reason=>{if(!abort.signal.aborted)setError(reason.message);}).finally(()=>{if(!abort.signal.aborted)setLoading(false);});
  },250);return()=>{clearTimeout(timer);abort.abort();};
 },[query]);
 const rows=[...new Map([...(value?[value]:[]),...options].map(item=>[`${item.kind}:${item.id}`,item])).values()];
 return <div className="misc-association-field"><label htmlFor="misc-association">关联款号 / PO（选填）</label><SearchableSelect id="misc-association" disabled={disabled} value={value?`${value.kind}:${value.id}`:''} onSearchChange={text=>{setQuery(text);if(text)onUnmatchedSearch();}} onChange={event=>onChange(rows.find(item=>`${item.kind}:${item.id}`===event.target.value)??null)}><option value="">不关联订单</option>{rows.map(item=><option key={`${item.kind}:${item.id}`} value={`${item.kind}:${item.id}`}>{item.label}</option>)}</SearchableSelect>
  <small>输入关键词选择已有档案或PO，可留空；同名候选按客户和颜色区分。</small>{loading&&<small role="status">正在查询已有资料…</small>}{error&&<p role="alert">{error}</p>}
 </div>;
}
