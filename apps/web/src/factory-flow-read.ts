import {useEffect,useRef,useState} from 'react';
import type {FactoryFlowSheet} from '@dx-rework/contracts/factory-flow';
import {digitalRequest} from './digital-production-api.js';

type Person={id:string;displayName:string;roles:string[]};
type Reading={orderId:string;sheet:FactoryFlowSheet|null;people:Person[];loading:boolean;error:string;peopleError:string};
/** Factory authorization and optional candidate loading are independent of
 * washing. Keep same-order forms mounted while refreshing, clear denied data. */
export function useFactoryFlowRead(orderId:string,enabled:boolean){
 const [state,setState]=useState<Reading|null>(null),sequence=useRef(0),active=useRef(orderId),mounted=useRef(false);
 active.current=orderId;
 const current=(turn:number)=>mounted.current&&active.current===orderId&&sequence.current===turn;
 const reload=async()=>{
  if(!enabled)return;
  const turn=++sequence.current;
  setState(value=>({orderId,sheet:value?.orderId===orderId?value.sheet:null,people:value?.orderId===orderId?value.people:[],loading:true,error:'',peopleError:''}));
  try{
   const sheet=await digitalRequest<FactoryFlowSheet>(`orders/${orderId}/factory-flow`);
   if(sheet.orderId!==orderId||!Array.isArray(sheet.lines)||!Array.isArray(sheet.tasks))throw Error('工厂资料回执不完整');
   if(!current(turn))return;
   setState({orderId,sheet,people:[],loading:false,error:'',peopleError:''});
   if(sheet.canManage)try{
    const people=await digitalRequest<Person[]>('access/candidates');
    if(current(turn))setState(value=>value?{...value,people}:value);
   }catch(error){if(current(turn))setState(value=>value?{...value,peopleError:error instanceof Error?error.message:'办理人员读取失败'}:value);}
  }catch(error){
   if(current(turn))setState({orderId,sheet:null,people:[],loading:false,error:error instanceof Error?error.message:'工厂资料读取失败',peopleError:''});
   throw error;
  }
 };
 useEffect(()=>{
  mounted.current=true;
  if(enabled)void reload().catch(()=>undefined);else setState(null);
  return()=>{mounted.current=false;sequence.current++;};
 },[orderId,enabled]);
 const accept=(sheet:FactoryFlowSheet)=>{
  if(!mounted.current||active.current!==orderId)return;
  if(sheet.orderId!==orderId)throw Error('工厂资料回执不属于本单');
  sequence.current++;setState(value=>({orderId,sheet,people:sheet.canManage&&value?.orderId===orderId?value.people:[],loading:false,error:'',peopleError:''}));
 };
 const visible=enabled&&state?.orderId===orderId?state:null;
 return {sheet:visible?.sheet??null,people:visible?.people??[],loading:enabled&&(!visible||visible.loading),readError:visible?.error??'',peopleError:visible?.peopleError??'',reload,accept};
}
