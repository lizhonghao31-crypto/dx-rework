import {useState} from 'react';

/** Same-origin authenticated route. No fallback to another file or version. */
export function QuotationBasisImage({href,label}:{href:string;label:string}){
 const [failed,setFailed]=useState(false);
 if(failed)return <p>{label}预览不可用。<a href={href}>查看原附件</a></p>;
 return <a href={href}><img className="quotation-basis-image" src={href} alt={label} loading="lazy" onError={()=>setFailed(true)}/></a>;
}
