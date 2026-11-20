import {useEffect,useState} from 'react';
import type {DigitalTask} from '@dx-rework/contracts/digital-production-tasks';
/** Per-page business input default only. Never changes Date, auth or retry timers. */
let current:{resourceId:string;now:string}|null=null;
export function observeAcceptanceTime(resourceId:string,now:string|null){
 if(now)current={resourceId,now};else if(current?.resourceId===resourceId)current=null;
}
export const acceptanceInputNow=()=>current?new Date(current.now):new Date();
export function acceptanceTaskNow(task:Pick<DigitalTask,'taskId'|'sourceId'|'orderId'|'acceptanceBusinessNow'>,fallback:Date){
 if(!task.acceptanceBusinessNow)return fallback;
 return current&&[task.taskId,task.sourceId,task.orderId].includes(current.resourceId)?new Date(current.now):new Date(task.acceptanceBusinessNow);
}
/** Refresh read-only time labels without remounting or clearing business forms. */
export function useAcceptanceClockUpdates(){
 const [,update]=useState(0);
 useEffect(()=>{const changed=()=>update(n=>n+1);window.addEventListener('acceptance-clock-changed',changed);return()=>window.removeEventListener('acceptance-clock-changed',changed);},[]);
}
