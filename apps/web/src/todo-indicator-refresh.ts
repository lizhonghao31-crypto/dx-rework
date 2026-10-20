import {cachedVerifiedSession} from './auth-session.js';
const TODO_INDICATOR_POLL_INTERVAL_MS = 60_000;
const CHANNEL='dx-rework:todo-read-v1';
const currentActor=()=>{const session=cachedVerifiedSession();return session&&session!=='denied'?session.user.id:null;};
export function publishTodoRead(actorId:string){
  window.dispatchEvent(new CustomEvent('dx-rework:todo-read',{detail:{actorId}}));
  if(typeof window.BroadcastChannel==='function'){const channel=new BroadcastChannel(CHANNEL);channel.postMessage({type:'todo-read',actorId});channel.close();}
}
export function subscribeTodoRead(refresh:()=>void|Promise<void>){
  const receive=(event:Event)=>{const id=(event as CustomEvent<{actorId?:string}>).detail?.actorId;if(!id||id===currentActor())void refresh();};
  const channel=typeof window.BroadcastChannel==='function'?new BroadcastChannel(CHANNEL):null;
  if(channel)channel.onmessage=event=>{if(event.data?.type==='todo-read'&&typeof event.data.actorId==='string'&&event.data.actorId===currentActor())void refresh();};
  window.addEventListener('dx-rework:todo-read',receive);
  return()=>{window.removeEventListener('dx-rework:todo-read',receive);channel?.close();};
}

export const installTodoIndicatorRefresh = (
  refresh: () => void | Promise<void>,
): (() => void) => {
  const run = () => void refresh();
  const handleVisibility = () => {
    if (document.visibilityState === "visible") run();
  };

  run();
  const interval = window.setInterval(run, TODO_INDICATOR_POLL_INTERVAL_MS);
  document.addEventListener("visibilitychange", handleVisibility);
  const unsubscribe=subscribeTodoRead(run);
  return () => {
    window.clearInterval(interval);
    document.removeEventListener("visibilitychange", handleVisibility);
    unsubscribe();
  };
};
