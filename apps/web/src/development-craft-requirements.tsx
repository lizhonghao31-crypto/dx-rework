import {Button} from '@astryxdesign/core/Button';
import {FileInput} from '@astryxdesign/core/FileInput';
import {TextArea} from '@astryxdesign/core/TextArea';
import {TextInput} from '@astryxdesign/core/TextInput';
import {
  developmentCraftOptions, type DevelopmentCraftRequirement, type DevelopmentDocument,
} from '@dx-rework/contracts/digital-development';
import type {ReactNode} from 'react';
import {AttachmentIdentity, type AttachmentIdentityData} from './attachment-identity.js';
import {DocumentSection} from './document-editor.js';

export const DEVELOPMENT_CRAFT_FILE_TYPES='image/jpeg,image/png,image/webp,application/pdf';

export function DevelopmentCraftRequirements({
  document, edit, controls, readonly, disabled, draftsOnly, upload, viewFile, fileIdentity, metadataPath,
}:{document:DevelopmentDocument;edit:(patch:Partial<DevelopmentDocument>)=>void;controls?:ReactNode;
  readonly:boolean;disabled:boolean;draftsOnly:boolean;
  upload:(files:File[],kind:'工艺开发板',stepKey:string)=>Promise<void>;viewFile:(id:string)=>string;
  fileIdentity?:((id:string)=>AttachmentIdentityData|undefined)|undefined;
  metadataPath?:((id:string)=>string|undefined)|undefined;
}){
  const steps=developmentCraftOptions(document),boards=document.files.filter(file=>file.kind==='工艺开发板');
  return <DocumentSection id="development-craft-requirements" title="工艺要求">
    {controls}
    {steps.map(({key,label})=>{
      const saved=document.craftRequirements?.find(row=>row.stepKey===key);
      if(readonly&&!saved)return null;
      const row=saved??{stepKey:key,part:'',specification:'',instructions:'',attachmentIds:[]};
      const change=(patch:Partial<DevelopmentCraftRequirement>)=>{
        const next={...row,...patch};
        const requirements=document.craftRequirements??[];
        edit({craftRequirements:saved?requirements.map(item=>item===saved?next:item):[...requirements,next]});
      };
      const availableBoards=boards.filter(file=>!row.attachmentIds.includes(file.attachmentId));
      return <fieldset key={key} className="development-craft-requirement">
        <legend>{label}</legend>
        {draftsOnly&&<p>对应师傅：待分派</p>}
        {readonly?<dl><dt>部位</dt><dd>{row.part||'—'}</dd><dt>规格 / 效果</dt><dd>{row.specification||'—'}</dd>
          <dt>制作说明</dt><dd>{row.instructions||'—'}</dd></dl>:
          <div className="development-craft-requirement-fields">
            <TextInput label={`${label}部位`} size="sm" value={row.part} ref={input=>{if(input)input.maxLength=100;}}
              isDisabled={disabled} onChange={part=>change({part})}/>
            <TextInput label={`${label}规格 / 效果`} size="sm" value={row.specification} ref={input=>{if(input)input.maxLength=100;}}
              isDisabled={disabled} onChange={specification=>change({specification})}/>
            <TextArea label={`${label}制作说明`} value={row.instructions} maxLength={1000} isDisabled={disabled} onChange={instructions=>change({instructions})}/>
          </div>}
        {row.attachmentIds.length>0&&<ul className="development-craft-attachments">{row.attachmentIds.map((id,index)=>{
          const file=fileIdentity?.(id), labelText=`${label}附件 ${index+1}`, url=viewFile(id);
          return <li key={id}>
            {url&&<a href={url} target="_blank" rel="noreferrer" aria-label={`查看${labelText}原件`}>
              {(!file||file.mimeType.startsWith('image/'))&&<img src={url} alt="" onError={event=>{event.currentTarget.hidden=true;}}/>}
              查看原件
            </a>}
            <AttachmentIdentity label={labelText} local={file} metadataPath={metadataPath?.(id)}/>
            {!readonly&&<Button label="解除本项引用" variant="ghost" size="sm" type="button" isDisabled={disabled}
              onClick={()=>change({attachmentIds:row.attachmentIds.filter(other=>other!==id)})}/>}
          </li>;
        })}</ul>}
        {!readonly&&<div className="development-craft-attachment-actions">
          <FileInput label={`添加${label}图片或文件`} value={null} isMultiple accept={DEVELOPMENT_CRAFT_FILE_TYPES}
            isDisabled={disabled||document.files.length>=30} onChange={files=>{if(files)void upload(Array.isArray(files)?files:[files],'工艺开发板',key);}}/>
          {availableBoards.length>0&&<label>引用已有工艺开发板
            <select aria-label={`${label}引用已有工艺开发板`} value="" disabled={disabled} onChange={event=>{
              const id=event.currentTarget.value;
              if(id)change({attachmentIds:[...row.attachmentIds,id]});
            }}>
              <option value="">选择本版附件</option>
              {availableBoards.map(file=><option key={file.attachmentId} value={file.attachmentId}>
                {fileIdentity?.(file.attachmentId)?.filename??`工艺开发板 ${boards.indexOf(file)+1}`}
              </option>)}
            </select>
          </label>}
        </div>}
      </fieldset>;
    })}
  </DocumentSection>;
}
