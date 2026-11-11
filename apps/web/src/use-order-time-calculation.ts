import {useEffect,useRef,useState} from 'react';
import type {OrderTimeCalculation,OrderTimeCalculationResult} from '@dx-rework/contracts/order-time-settings';
import {digitalRequest} from './digital-production-api.js';
/** Only the owned obsolete read is cancelled; no write or shared refresh. */
export function useOrderTimeCalculation(input:OrderTimeCalculation|null){
 const [state,setState]=useState<{key:string;result:OrderTimeCalculationResult|null;error:string;loading:boolean}>({key:'',result:null,error:'',loading:false}),sequence=useRef(0);
 const key=JSON.stringify(input);
 useEffect(()=>{
  const generation=++sequence.current,controller=new AbortController();setState({key,result:null,error:'',loading:!!input});
  if(!input)return;
  const timer=setTimeout(()=>{void digitalRequest<OrderTimeCalculationResult>('order-time-settings/calculate','POST',input,undefined,{signal:controller.signal}).then(next=>{if(generation===sequence.current){if(!Array.isArray(next.lines)||!next.lines.length)throw Error('演算结果不完整，请重试');setState({key,result:next,error:'',loading:false});}}).catch(reason=>{if(generation===sequence.current&&reason.name!=='AbortError')setState({key,result:null,error:reason.message,loading:false});});},200);
  return()=>{clearTimeout(timer);controller.abort();};
 },[key]);
 return state.key===key?state:{result:null,error:'',loading:!!input};
}
