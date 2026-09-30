import {useEffect,useState} from 'react';
import {Button} from '@dx-rework/ui';
import {PatternCategoryOptionsSchema} from '@dx-rework/contracts/pattern-room';
import {patternRequest} from './pattern-order-client.js';
import {usePatternQuote} from './use-pattern-quote.js';
export function DevelopmentPatternLink({busy,onSubmit}:{busy:boolean;onSubmit:(input:{categoryId:string;priceVersion:number})=>void}){
 const [categories,setCategories]=useState<{priceId:string;name:string;unit:string}[]>([]),[categoryId,setCategoryId]=useState(''),[revision,setRevision]=useState(0),[error,setError]=useState('');
 const price=usePatternQuote(categoryId?`category-options/${categoryId}/quote`:null,revision);
 useEffect(()=>{const abort=new AbortController();void patternRequest('category-options',PatternCategoryOptionsSchema,{signal:abort.signal}).then(setCategories).catch(reason=>{if(!abort.signal.aborted)setError(reason.message);});return()=>abort.abort();},[]);
 return <form onSubmit={event=>{event.preventDefault();if(price.quote)onSubmit({categoryId,priceVersion:price.quote.version});}}><fieldset disabled={busy}><legend>提交打板执行</legend><p>沿用本开发单款号、数量及制作资料，技术主管按原打板流程确认派工和计价。</p>{error&&<p role="alert">{error}</p>}<label>打板品类<select value={categoryId} required onChange={event=>setCategoryId(event.target.value)}><option value="">请选择</option>{categories.map(item=><option key={item.priceId} value={item.priceId}>{item.name}</option>)}</select></label>{price.status==='error'&&<p role="alert">{price.message}</p>}{price.quote&&<p>当前单价：{price.quote.amount} 元/{price.quote.unit}</p>}<Button type="button" onClick={()=>setRevision(value=>value+1)}>刷新价格</Button><Button type="submit" disabled={!price.quote}>提交打板</Button></fieldset></form>;
}
