import {useEffect,useRef,type ReactNode} from 'react';
import {Button} from '@dx-rework/ui';
import {trapCockpitDialogFocus} from './cockpit-dialog-focus.js';

/** Same native modal/focus contract as the existing cockpit photo preview. */
export function CockpitHomeDialog({title,onClose,children,busy=false}:{title:string;onClose:()=>void;children:ReactNode;busy?:boolean}){
 const dialog=useRef<HTMLDialogElement>(null),backdropDown=useRef(false);
 useEffect(()=>{
  const view=dialog.current;if(!view)return;
  const trigger=document.activeElement instanceof HTMLElement?document.activeElement:null,overflow=document.body.style.overflow,padding=document.body.style.paddingRight;
  const scrollbar=Math.max(0,window.innerWidth-document.documentElement.clientWidth);
  if(scrollbar)document.body.style.paddingRight=`${parseFloat(getComputedStyle(document.body).paddingRight||'0')+scrollbar}px`;
  view.showModal();document.body.style.overflow='hidden';
  return()=>{view.close();document.body.style.overflow=overflow;document.body.style.paddingRight=padding;if(trigger?.isConnected)trigger.focus();};
 },[]);
 return <dialog ref={dialog} className="cockpit-photo-dialog cockpit-home-dialog" aria-label={title} onClose={onClose} onCancel={event=>{if(busy)event.preventDefault();}} onKeyDown={trapCockpitDialogFocus}
  onPointerDown={event=>{const box=event.currentTarget.getBoundingClientRect();backdropDown.current=event.target===event.currentTarget&&(event.clientX<box.left||event.clientX>box.right||event.clientY<box.top||event.clientY>box.bottom);}}
  onClick={event=>{const box=event.currentTarget.getBoundingClientRect();if(!busy&&backdropDown.current&&event.target===event.currentTarget&&(event.clientX<box.left||event.clientX>box.right||event.clientY<box.top||event.clientY>box.bottom))event.currentTarget.close();backdropDown.current=false;}}>
  <header><h2>{title}</h2><Button type="button" variant="secondary" disabled={busy} autoFocus aria-label={`关闭${title}`} onClick={()=>dialog.current?.close()}>关闭</Button></header>
  {children}
 </dialog>;
}
