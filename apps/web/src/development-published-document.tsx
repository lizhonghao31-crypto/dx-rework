import {useRef,useState} from 'react';
import type {DevelopmentDocument,DevelopmentPublishedVersion,DevelopmentSheet} from '@dx-rework/contracts/digital-development';
import {Button} from '@dx-rework/ui';
import {createWebUrls} from '../url-contract.js';
import {DevelopmentDocumentFields} from './development-document-fields.js';
import {DevelopmentPrint} from './digital-development-print.js';
import {developmentSizeQuantityInputs} from './digital-development-editing.js';
import {DocumentToolbar} from './document-editor.js';
import './digital-development.css';

const urls=createWebUrls(import.meta.env.BASE_URL);
const ignore=()=>{};
const noIssue=()=>undefined;
const noUpload=async()=>{};

/** Original complete form and print component, with an exact immutable input.
 * This reader has no save/upload/autosave command or execution controller.
 */
export function DevelopmentPublishedDocument({value,blocked=false,onSwitch}:{value:DevelopmentPublishedVersion;blocked?:boolean;onSwitch?:(()=>void)|undefined}){
 return <SnapshotForm key={`${value.sourceId}:${value.roundNumber}:${value.documentVersion}`} value={value} blocked={blocked} onSwitch={onSwitch}/>;
}
function SnapshotForm({value,blocked,onSwitch}:{value:DevelopmentPublishedVersion;blocked:boolean;onSwitch:(()=>void)|undefined}){
 const [fileKind,setFileKind]=useState<DevelopmentDocument['files'][number]['kind']>('款图');
 const writing=useRef(false),successfulUploads=useRef(new Map<string,string>());
 const measurementIds=useRef(value.document.measurements.map((_,index)=>`published-measurement-${index}`));
 const base=`sources/${value.sourceId}/development/versions/${value.documentVersion}`;
 const imageUrl=(id:string)=>urls.apiUrl(`digital-production/${base}/attachments/${id}?round=${value.roundNumber}`);
 const sheet:DevelopmentSheet={sourceId:value.sourceId,designStyleNo:value.designStyleNo,temporaryStyleNo:value.temporaryStyleNo,
  customerCode:value.customerCode,developmentType:value.developmentType,designerName:value.designerName,version:value.documentVersion,
  roundNumber:value.roundNumber,status:'published',document:value.document,publishedAt:value.publishedAt,taskId:null,canEdit:false,canRevise:false,materialEvents:[],metadata:value.metadata};
 return <section className="development-editor dx-doc-development" aria-label="开发原单精确版本">
  <DocumentToolbar title={`开发单 · ${value.designStyleNo}`} status={`只读 · 第${value.roundNumber}轮 · 资料版本 ${value.documentVersion}`}>
   {onSwitch&&<Button type="button" onClick={onSwitch}>切换单据</Button>}
   <Button type="button" disabled={blocked} onClick={()=>window.print()}>打印 / 保存 PDF</Button>
  </DocumentToolbar>
  <div inert={blocked}>
  <DevelopmentPrint sheet={sheet} document={value.document} imageUrl={imageUrl}/>
  <DevelopmentDocumentFields document={value.document} readonly materialFactsReadonly busy={false} fixedCraft={Boolean(value.document.craftSteps)}
   edit={ignore} writing={writing} quantityInput={value.document.quantity===null?'':String(value.document.quantity)} setQuantityInput={ignore}
   sizeQuantityInputs={developmentSizeQuantityInputs(value.document)} setSizeQuantityInputs={ignore} measurementIds={measurementIds}
   successfulUploads={successfulUploads} fileKind={fileKind} setFileKind={setFileKind} imageUrl={imageUrl}
   metadataPath={id=>`${base}/attachments/${id}/metadata?round=${value.roundNumber}`} upload={noUpload} issue={noIssue}
   templateResetKey={`${value.roundNumber}:${value.documentVersion}`} attachmentPageSize={6}/>
  </div>
 </section>;
}
