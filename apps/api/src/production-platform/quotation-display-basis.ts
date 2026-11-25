import type {PoolClient} from 'pg';
import type {DevelopmentDocument} from '@dx-rework/contracts/digital-development';
import type {IeProcessingEntry} from '@dx-rework/contracts/digital-quotation';
import {digitalFormalPoNo,digitalPoKey} from '@dx-rework/contracts/digital-production';
import {developmentDocumentSnapshot} from './development-document-snapshot.js';
import {publishedTechnicalArtifact,technicalDocumentFingerprint} from './development-technical-repository.js';

export function quotationStyleImage(sourceId:string,documentVersion:number,document:DevelopmentDocument){
 const attachmentId=document.files.find(file=>file.kind==='款图')?.attachmentId;
 return attachmentId?{sourceId,documentVersion,attachmentId}:null;
}

/** Both numbers designated as formal must agree. Do not search claimed aliases as POs. */
export function quotationFormalPos(lines:ReadonlyArray<{formalStyleNo:string|null;poNumber:string|null}>){
 return lines.flatMap(line=>{
  if(new Set([line.formalStyleNo,line.poNumber].map(digitalPoKey).filter(Boolean)).size>1)return [];
  const value=digitalFormalPoNo(line);return value?[value]:[];
 });
}

/** Only used after the exact IE row has passed the existing role and row check.
 * Original version only. Return the technical basis, not the design/quote document. */
export async function readIeProcessingBasis(db:Pick<PoolClient,'query'>,entry:IeProcessingEntry):Promise<IeProcessingEntry['basis']>{
 const ref=(await db.query<{source_id:string;source_version:number;development_type:string}>(`SELECT q.source_id,s.development_type,
  (q.assembly->>'sourceVersion')::int AS source_version FROM digital_quotation_documents q JOIN digital_production_sources s USING(source_id)
  WHERE q.quote_id=$1 AND q.version=$2 AND (q.assembly->>'roundNumber')::int=$3`,[entry.quoteId,entry.version,entry.round])).rows[0];
 if(!ref)return null;
 const source=await developmentDocumentSnapshot(db,ref.source_id,entry.round,ref.source_version,true);
 if(!source)return null;
 const {document}=source,technical=await publishedTechnicalArtifact(db,ref.source_id,entry.round);
 const currentTechnical=technical?.row.document_fingerprint===technicalDocumentFingerprint(document)?technical.artifact:null;
 const table=currentTechnical?.body.baseSizeTable;
 const lines=entry.resource.kind==='order'?(await db.query<{formalStyleNo:string|null;poNumber:string|null}>(`SELECT
  formal_style_no AS "formalStyleNo",po_number AS "poNumber" FROM digital_production_po_lines WHERE production_order_id=$1 ORDER BY position`,[entry.resource.id])).rows:[];
 return {sourceVersion:ref.source_version,developmentType:ref.development_type,template:document.template,instructions:document.instructions,
  craft:document.craft,washing:document.washing,materials:document.materials.filter(row=>row.name||row.specification)
   .map(row=>({category:row.category,name:row.name,specification:row.specification})),
  sizeUnit:table?.unit??document.unit,sizes:table?.sizes??document.sizes,measurements:(table?.measurements??document.measurements).map(({name,values})=>({name,values})),
  quantity:document.quantity,technicalVersion:currentTechnical?.version??null,formalPoNos:quotationFormalPos(lines),
  styleImage:quotationStyleImage(ref.source_id,ref.source_version,document)};
}
