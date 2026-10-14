import { SearchableSelect } from "./search-select.js";
import {useEffect,useState} from 'react';
import {Button} from '@dx-rework/ui';
import {PatternCategoryOptionsSchema} from '@dx-rework/contracts/pattern-room';
import {patternRequest} from './pattern-order-client.js';
import {usePatternQuote} from './use-pattern-quote.js';
export type DevelopmentPatternChoice={categoryId:string;priceVersion:number};
export function DevelopmentPatternLink({busy,onSubmit,onSelection,preparing=false}:{busy:boolean;onSubmit?:(input:DevelopmentPatternChoice)=>void;onSelection?:(input:DevelopmentPatternChoice|null)=>void;preparing?:boolean}){
 const [categories,setCategories]=useState<{priceId:string;name:string;unit:string}[]>([]),[categoryId,setCategoryId]=useState(''),[revision,setRevision]=useState(0),[error,setError]=useState('');
 const price=usePatternQuote(categoryId?`category-options/${categoryId}/quote`:null,revision);
 useEffect(()=>{const abort=new AbortController();void patternRequest('category-options',PatternCategoryOptionsSchema,{signal:abort.signal}).then(setCategories).catch(reason=>{if(!abort.signal.aborted)setError(reason.message);});return()=>abort.abort();},[]);
 useEffect(()=>{onSelection?.(price.quote?{categoryId,priceVersion:price.quote.version}:null);},[categoryId,price.quote?.version,onSelection]);
 const select=<label>打板品类<SearchableSelect aria-label="打板品类" value={categoryId} required disabled={busy} onChange={event=>{onSelection?.(null);setCategoryId(event.target.value);}}><option value="">请选择</option>{categories.map(item=><option key={item.priceId} value={item.priceId}>{item.name}</option>)}</SearchableSelect></label>;
 if(preparing)return <div className="development-pattern-preparation">{error&&<p role="alert">{error}</p>}{select}{price.status==='error'&&<p role="alert">{price.message}</p>}<div className="development-price-quote">{price.quote?<span>执行单价：{price.quote.amount} 元/{price.quote.unit}</span>:<span>选择有效品类后核对单价</span>}<Button type="button" disabled={busy} onClick={()=>{onSelection?.(null);setRevision(value=>value+1);}}>刷新价格</Button></div></div>;
 const fields=<fieldset disabled={busy}><legend>{preparing?"正式提交的打板准备":"提交打板执行"}</legend><p>沿用本开发单款号、数量及制作资料，技术主管按原打板流程确认派工和计价。</p>{error&&<p role="alert">{error}</p>}{select}{price.status==='error'&&<p role="alert">{price.message}</p>}{price.quote&&<p>当前单价：{price.quote.amount} 元/{price.quote.unit}</p>}<Button type="button" onClick={()=>{onSelection?.(null);setRevision(value=>value+1);}}>刷新价格</Button>{!preparing&&<Button type="submit" disabled={!price.quote}>提交打板</Button>}</fieldset>;
 return <form onSubmit={event=>{event.preventDefault();if(price.quote)onSubmit?.({categoryId,priceVersion:price.quote.version});}}>{fields}</form>;
}
