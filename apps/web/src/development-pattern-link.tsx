import {confirmInApp} from './system-dialog.js';
import {Selector} from '@astryxdesign/core/Selector';
import { SearchableSelect } from "./search-select.js";
import {useEffect,useRef,useState} from 'react';
import {Button} from '@dx-rework/ui';
import {PatternCategoryOptionsSchema} from '@dx-rework/contracts/pattern-room';
import {patternRequest} from './pattern-order-client.js';
import {usePatternQuote} from './use-pattern-quote.js';
export type DevelopmentPatternChoice={categoryId:string;priceVersion:number};
export function DevelopmentPatternLink({busy,onSubmit,onSelection,preparing=false,selectedCategoryId,onCategoryChange}:{busy:boolean;onSubmit?:(input:DevelopmentPatternChoice)=>void;onSelection?:(input:DevelopmentPatternChoice|null)=>void;preparing?:boolean;selectedCategoryId?:string;onCategoryChange?:(categoryId:string)=>void}){
 const [categories,setCategories]=useState<{priceId:string;name:string;unit:string}[]>([]),[localCategoryId,setCategoryId]=useState(''),[revision,setRevision]=useState(0),[error,setError]=useState('');
 const categoryId=selectedCategoryId??localCategoryId;
 const price=usePatternQuote(categoryId?`category-options/${categoryId}/quote`:null,revision);
 const lastQuote=useRef<{categoryId:string;quote:NonNullable<typeof price.quote>}|null>(null);
 if(price.quote)lastQuote.current={categoryId,quote:price.quote};
 const displayedQuote=price.quote??(lastQuote.current?.categoryId===categoryId?lastQuote.current.quote:null);
 useEffect(()=>{const abort=new AbortController();void patternRequest('category-options',PatternCategoryOptionsSchema,{signal:abort.signal}).then(setCategories).catch(reason=>{if(!abort.signal.aborted)setError(reason.message);});return()=>abort.abort();},[]);
 useEffect(()=>{onSelection?.(price.quote?{categoryId,priceVersion:price.quote.version}:null);},[categoryId,price.quote?.version,onSelection]);
 const changeCategory=async(next:string)=>{
  if(categoryId&&next!==categoryId&&!await confirmInApp("切换打板品类将重新读取执行单价，不修改尺寸模板或历史工资。继续？"))return;
  onSelection?.(null);setCategoryId(next);onCategoryChange?.(next);
 };
 const select=preparing?<Selector label="打板品类" placeholder="请选择" isRequired size="sm" value={categoryId} hasSearch
  searchPlaceholder="搜索打板品类" isDisabled={busy} options={categories.map(item=>({value:item.priceId,label:item.name}))}
  onChange={next=>void changeCategory(next)}/>:
  <label>打板品类 *<SearchableSelect aria-label="打板品类" value={categoryId} required disabled={busy}
   onChange={event=>void changeCategory(event.target.value)}>
   <option value="">请选择</option>{categories.map(item=><option key={item.priceId} value={item.priceId}>{item.name}</option>)}
  </SearchableSelect></label>;
 if(preparing)return <div className="development-pattern-preparation">{error&&<p role="alert">{error}</p>}{select}{price.status==='error'&&<p role="alert">{price.message}；原报价仅供核对，请刷新成功后发布。</p>}<div className="development-price-quote">{displayedQuote?<span>{price.quote?"执行单价":"上次报价"}：{displayedQuote.amount} 元/{displayedQuote.unit}{price.status==='loading'?" · 正在刷新":""}</span>:<span>{price.status==="loading"?"执行单价正在读取…":categoryId?"请先读取有效执行价":""}</span>}<Button type="button" disabled={busy||price.status==='loading'} onClick={()=>{onSelection?.(null);setRevision(value=>value+1);}}>刷新价格</Button></div></div>;
 const fields=<fieldset disabled={busy}><legend>{preparing?"正式提交的打板准备":"提交打板执行"}</legend><p>沿用本开发单款号、数量及制作资料，技术主管按原打板流程确认派工和计价。</p>{error&&<p role="alert">{error}</p>}{select}{price.status==='error'&&<p role="alert">{price.message}</p>}{price.quote&&<p>当前单价：{price.quote.amount} 元/{price.quote.unit}</p>}<Button type="button" onClick={()=>{onSelection?.(null);setRevision(value=>value+1);}}>刷新价格</Button>{!preparing&&<Button type="submit" disabled={!price.quote}>提交打板</Button>}</fieldset>;
 return <form onSubmit={event=>{event.preventDefault();if(price.quote)onSubmit?.({categoryId,priceVersion:price.quote.version});}}>{fields}</form>;
}
