import type {KeyboardEvent} from "react";
export function trapCockpitDialogFocus(event:KeyboardEvent<HTMLDialogElement>){
  if(event.key!=="Tab")return;
  const controls=[...event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex='-1'])")].filter(element=>element.getClientRects().length>0&&getComputedStyle(element).visibility!=="hidden");
  const first=controls[0],last=controls.at(-1),active=document.activeElement;
  if((event.shiftKey&&active===first)||(!event.shiftKey&&active===last)||!event.currentTarget.contains(active)){
    event.preventDefault();(event.shiftKey?last:first)?.focus();
  }
}
