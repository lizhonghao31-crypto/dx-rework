import {Surface} from '@dx-rework/ui';
import {Shell} from './components.js';
import {AuxiliaryCatalogDialog} from './auxiliary-catalog-dialog.js';
export function AuxiliaryCatalogPage(){
 return <Shell active="共享辅料目录"><Surface><AuxiliaryCatalogDialog presentation="page" onClose={()=>undefined}/></Surface></Shell>;
}
