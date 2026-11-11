import type {OrderJourney} from '@dx-rework/contracts/digital-production-journey';
import type {CockpitDocumentCategory} from './cockpit-document-catalog.js';
import type {CockpitDocumentEntry,CockpitDocumentReader,CockpitDocumentResult} from './cockpit-document-data.js';
import {technicalDirectory,productionTechnicalDirectory,quotationDirectory,loadTechnicalEntry} from './cockpit-documents-technical.js';
import{technicalPartDirectory,selectTechnicalPart,type TechnicalPart}from'./cockpit-technical-parts.js';
import {preparationDirectory,bulkTechnicalDirectory,qcDirectory,factoryDirectory,receivingDirectory,reworkDirectory,loadProductionEntry} from './cockpit-documents-production.js';
export async function loadExtendedCockpitCategory(order:OrderJourney,key:CockpitDocumentCategory,read:CockpitDocumentReader,signal:AbortSignal):Promise<CockpitDocumentResult|undefined>{
 const parts:Partial<Record<CockpitDocumentCategory,TechnicalPart>>={development_plt:'plt',development_sizes:'sizes',development_consumption:'consumption',customer_comments:'comment',customer_final_approval:'final'};
 if(parts[key])return technicalPartDirectory(order,parts[key]!,read,signal);
 if(key==='development_technical')return technicalDirectory(order,read,signal);
 if(key==='quotation')return quotationDirectory(order,read,signal);
 if(key==='technical')return bulkTechnicalDirectory(order,read,signal);
 if(key==='qc_progress')return qcDirectory(order,read,signal);
 if(key==='preparation')return preparationDirectory(order,read,signal);
 if(key==='factory'||key==='factory_history'||key==='ship_sample')return factoryDirectory(order,read,signal,key);
 if(key==='receiving'||key==='packing'||key==='closure')return receivingDirectory(order,read,signal,key);
 if(key==='rework')return reworkDirectory(order);
}
export async function loadExtendedCockpitEntry(entry:CockpitDocumentEntry,read:CockpitDocumentReader,signal:AbortSignal){
 if(entry.load?.kind==='technical_directory'){
  if(entry.load.part&&!entry.load.productionArtifact){const data=await technicalPartDirectory({sourceId:entry.load.id,selectedRound:Number(entry.load.round)},entry.load.part,read,signal,entry.load.scopeRef);return {...entry,load:undefined,children:data.entries,note:data.note};}
  const data=entry.load.productionArtifact?await productionTechnicalDirectory(entry,read,signal):await technicalDirectory({sourceId:entry.load.id,selectedRound:Number(entry.load.round)},read,signal,entry.load.scopeRef);return {...entry,load:undefined,children:data.entries,note:data.note};
 }
 const technical=await loadTechnicalEntry(entry,read,signal);
 if(technical)return entry.load?.part?selectTechnicalPart(technical,entry.load.part):technical;
 return loadProductionEntry(entry,read,signal);
}
