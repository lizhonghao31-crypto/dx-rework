import {useState,type ReactNode} from 'react';
/** Mount history after the first expansion; retain it for subsequent folds in this detail version. */
export function LazyHistoryDetails({summary,children}:{summary:string;children:ReactNode}){
 const [mounted,setMounted]=useState(false);
 return <details onToggle={event=>{if(event.currentTarget.open)setMounted(true);}}><summary>{summary}</summary>{mounted?children:null}</details>;
}
