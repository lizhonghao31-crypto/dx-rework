import {useEffect,useRef,useState} from 'react';
import {Button} from '@dx-rework/ui';
import type {DevelopmentSheet} from '@dx-rework/contracts/digital-development';
import {ShortLeadPanel} from './short-lead-panel.js';
import {ResumeDevelopmentCreateForm} from './digital-development-create-form.js';
import {digitalRequest} from './digital-production-api.js';
import {verifySession} from './auth.js';
import {registerSessionInvalidator} from './auth-session.js';
export function ShortLeadWorkspace({sourceId,onClose}:{sourceId:string;onClose():void}){
 const [sheet,setSheet]=useState<DevelopmentSheet|null>(null),[error,setError]=useState(''),[editing,setEditing]=useState(false),[confirmed,setConfirmed]=useState<string|null>(null),[reload,setReload]=useState(0),owner=useRef(sourceId);owner.current=sourceId;
 const generation=useRef(0);
 useEffect(()=>registerSessionInvalidator(()=>{generation.current++;setSheet(null);setEditing(false);setConfirmed(null);setReload(value=>value+1);}),[]);
 useEffect(()=>{setConfirmed(null);},[sourceId]);
 useEffect(()=>{let live=true;const epoch=++generation.current;setSheet(null);setError('');setEditing(false);void(async()=>{const session=await verifySession();if(session==='denied'||session.status!=='authorized')throw Error('当前身份尚未获准查看本来源，请重新核对权限。');const value=await digitalRequest<DevelopmentSheet>(`sources/${sourceId}/development`);if(live&&epoch===generation.current&&owner.current===sourceId)setSheet(value);})().catch(error=>{if(live&&epoch===generation.current&&owner.current===sourceId)setError(error.message);});return()=>{live=false;generation.current++;};},[sourceId,reload]);
 return <section aria-label="原单短交期办理"><header><Button onClick={onClose}>返回我的工作</Button><h1>{sheet?.designStyleNo??'短交期正式单特批'}</h1></header>{error&&<p role="alert">{error}</p>}{!sheet&&!error&&<p>正在读取原来源及办理权限…</p>}{confirmed&&<p role="status">正式确认已成功，关联订单编号：{confirmed}。请保留原来源继续查看，不要新建另一单。</p>}{!editing&&<><ShortLeadPanel key={sourceId} sourceId={sourceId} readOnly defaultOpen/>{sheet?.canEdit&&!sheet.productionOrderId&&!confirmed&&<Button onClick={()=>setEditing(true)}>回本来源继续发布与正式确认</Button>}<Button onClick={()=>setReload(value=>value+1)}>重新读取原来源</Button></>}{editing&&sheet&&<ResumeDevelopmentCreateForm key={sourceId} sheet={sheet} contained onClose={()=>setEditing(false)} onCreated={(_source,orderId)=>{setEditing(false);if(orderId)setConfirmed(orderId);else setReload(value=>value+1);}}/>}</section>;
}
