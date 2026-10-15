import {useEffect,useState} from 'react';
import type {OrderJourney} from '@dx-rework/contracts/digital-production-journey';
import {digitalRequest} from './digital-production-api.js';
import {journeyDocumentGroups} from './digital-journey-cockpit-model.js';
import {createWebUrls} from '../url-contract.js';
const urls=createWebUrls(import.meta.env.BASE_URL);
export function RelatedDocumentRecords({id,round}:{id:string;round?:number|undefined}){
 const [journey,setJourney]=useState<OrderJourney|null>(null),[error,setError]=useState('');
 useEffect(()=>{let live=true;setJourney(null);setError('');void digitalRequest<OrderJourney>(`journeys/${id}${round?`?round=${round}`:''}`).then(value=>{if(live)setJourney(value);}).catch(reason=>{if(live)setError(reason.message);});return()=>{live=false;};},[id,round]);
 if(error)return <p role="alert">关联单据读取失败：{error}</p>;
 if(!journey)return <p role="status">正在读取授权关联单据…</p>;
 const entries=journeyDocumentGroups(journey).filter(group=>['sourcing','cutting'].includes(group.domain)).flatMap(group=>group.entries).filter(entry=>entry.record.url);
 return <section><h2>其他关联单据</h2>{entries.length?entries.map(entry=><p key={entry.key}><a href={urls.pageUrl(entry.record.url!)}>{entry.label}</a></p>):<p>没有可见的关联外发合同或裁床单。</p>}<p>沿用原单据及独立权限，不复制附件或另建记录。</p></section>;
}
