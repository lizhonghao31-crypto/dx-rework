import {createContext,useContext,useEffect,useId,useRef,type ComponentProps} from 'react';
import {createPortal} from 'react-dom';
import {Button} from '@dx-rework/ui';
export const WorkbenchActionTarget=createContext<HTMLElement|null>(null);
/** Keep the original form/command; only move its submit button to the shared footer. */
export function WorkbenchAction(props:ComponentProps<typeof Button>){
 const target=useContext(WorkbenchActionTarget),anchor=useRef<HTMLSpanElement>(null),id=useId();
 useEffect(()=>{if(props.type!=='submit')return;const form=anchor.current?.closest('form');if(form)form.id=id;},[id,target,props.type]);
 return <span ref={anchor}>{target?createPortal(<Button {...props} {...(props.type==='submit'?{form:id}:{})}/>,target):<Button {...props}/>}</span>;
}
