import {useEffect,useRef,useState} from 'react';
import {registerSessionInvalidator} from './auth-session.js';

type ReadResult<T>={target:string;value:T};
type Snapshot<T>={scope:string;target:string;result:ReadResult<T>|null;error:Error|null;settled:boolean};

/** Only preserve previously accepted data within the same read scope.
 * The caller chooses whether the pending read belongs to a foreground action. */
export function useForegroundRead<T>(scope:string,target:string|null,load:(signal:AbortSignal)=>Promise<T>,keepPrevious=false){
 const [generation,setGeneration]=useState(0);
 const [snapshot,setSnapshot]=useState<Snapshot<T>|null>(null);
 const running=useRef<AbortController|null>(null);
 const identity=target===null?null:JSON.stringify([scope,target]);
 const silentTarget=useRef<string|null>(null);
 const queuedRetry=useRef<string|null>(null);
 useEffect(()=>registerSessionInvalidator(()=>{
  running.current?.abort();
  if(running.current)running.current=null;
  silentTarget.current=identity;queuedRetry.current=null;
  setSnapshot(null);
  setGeneration(value=>value+1);
 }),[identity]);
 useEffect(()=>{
  if(target===null)return;
  if(silentTarget.current!==identity)silentTarget.current=null;
  const abort=new AbortController();
  queuedRetry.current=null;running.current=abort;
  setSnapshot(previous=>({scope,target,
   result:previous?.scope===scope&&(keepPrevious||previous.target===target)?previous.result:null,error:null,settled:false}));
  void load(abort.signal).then(value=>{
   if(!abort.signal.aborted)setSnapshot({scope,target,result:{target,value},error:null,settled:true});
  }).catch((reason:unknown)=>{
   if(!abort.signal.aborted)setSnapshot({scope,target,result:null,error:reason instanceof Error?reason:Error(String(reason)),settled:true});
  }).finally(()=>{
   if(running.current===abort)running.current=null;
  });
  return ()=>{
   abort.abort();
   if(running.current===abort)running.current=null;
  };
 },[scope,target,identity,load,keepPrevious,generation]);
 const exact=snapshot?.scope===scope&&snapshot.target===target;
 const waiting=target!==null&&(!exact||!snapshot.settled);
 const visible=snapshot?.scope===scope&&(exact||keepPrevious)?snapshot.result:null;
 const refresh=(silent:boolean)=>{
  if(target===null||(!silent&&(running.current||queuedRetry.current===identity)))return;
  queuedRetry.current=identity;silentTarget.current=silent?identity:null;
  setGeneration(value=>value+1);
 };
 return {
  value:visible?.value??null,loadedTarget:visible?.target??null,
  error:exact?snapshot?.error??null:null,
  waiting,foregroundKey:waiting&&silentTarget.current!==identity?JSON.stringify([scope,target,generation]):undefined,
  retry:()=>refresh(false),refreshSilently:()=>refresh(true),
 };
}
