import {createHash} from 'node:crypto';
import {developmentCraftOptions,type DevelopmentDocument} from '@dx-rework/contracts/digital-development';
import type {QuotationAssembly} from '@dx-rework/contracts/digital-quotation';

type CraftSnapshot={
 sourceId:string;
 round:number;
 version:number;
 document:Pick<DevelopmentDocument,'craft'|'craftSteps'|'craftRequirements'|'files'>;
};
type RowReference=QuotationAssembly['rows'][string];

/** Resolve a development craft from the original selected step and board. */
export function secondaryCraftDevelopmentBasis(snapshot:CraftSnapshot,row:RowReference){
 if(row.kind!=='craft'||row.stage!=='development'||!row.sourceRef.startsWith('craft:'))return null;
 const craftKey=row.sourceRef.slice('craft:'.length);
 if(row.craftRef&&craftKey!==`special:${row.craftRef.libraryId}`)return null;
 const requirementKey=row.craftRef?`${craftKey}:${row.craftRef.libraryVersion}`:craftKey;
 const selected=developmentCraftOptions(snapshot.document).find(step=>step.key===requirementKey);
 if(!selected)return null;
 const matches=snapshot.document.craftRequirements?.filter(item=>item.stepKey===requirementKey)??[];
 if(matches.length>1)return null;
 const requirement=matches[0]??null;
 const boardIds=new Set(snapshot.document.files.filter(file=>file.kind==='工艺开发板').map(file=>file.attachmentId));
 if(requirement?.attachmentIds.some(id=>!boardIds.has(id)))return null;
 // Keep the source version for display and original-file lookup. Only a change
 // in the selected craft's evidence changes the approval basis.
 const fingerprint=createHash('sha256').update(JSON.stringify({
  sourceId:snapshot.sourceId,round:snapshot.round,stage:row.stage,stepKey:selected.key,stepId:row.craftRef?.stepId??null,
  requirement:requirement?[requirement.part,requirement.specification,requirement.instructions,[...requirement.attachmentIds].sort()]:null,
 })).digest('hex');
 return {sourceId:snapshot.sourceId,round:snapshot.round,sourceVersion:snapshot.version,
  stepKey:selected.key,label:selected.label,requirement,fingerprint};
}
