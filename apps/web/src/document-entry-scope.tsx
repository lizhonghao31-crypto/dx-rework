import {createContext,useContext,useState,type ReactNode} from 'react';
import {createPortal} from 'react-dom';
import {canLeaveInternalPage} from './internal-navigation.js';
import {Button} from '@dx-rework/ui';
import {OrderDocumentContainer,type DocumentCategory} from './order-document-container.js';

type EntryContext={open:(category:DocumentCategory)=>void;targets:Partial<Record<DocumentCategory,HTMLElement>>};
const Entries=createContext<EntryContext|null>(null);
/** Move the original controls, not their command/state owner, into the document directory. */
export function DocumentEntryScope({sourceId,orderId,round,children,taskId}:{sourceId?:string;orderId?:string;round?:number;taskId?:string|undefined;children:ReactNode}){
 const [category,setCategory]=useState<DocumentCategory|null>(null),[targets,setTargets]=useState<Partial<Record<DocumentCategory,HTMLElement>>>({});
 const install=(next:Partial<Record<DocumentCategory,HTMLElement>>)=>setTargets(next);
 return <Entries.Provider value={{open:setCategory,targets}}><div hidden={category!==null}>{children}</div>{category!==null&&<OrderDocumentContainer initial={sourceId?{kind:'development',id:sourceId,version:round}:{kind:'instruction',id:orderId!}} taskId={taskId} initialCategory={category} onCategory={setCategory} onSlots={install} onClose={()=>{void canLeaveInternalPage().then(leave=>{if(leave)setCategory(null);});}}/>}</Entries.Provider>;
}
export function DocumentEntry({category,label,children}:{category:DocumentCategory;label:string;children:ReactNode}){
 const context=useContext(Entries);
 if(!context)return <>{children}</>;
 const target=context.targets[category];
 return <><Button type="button" onClick={()=>context.open(category)}>本单资料 · {label}</Button>{target&&createPortal(children,target)}</>;
}
