import {useCallback} from 'react';
import {Button} from '@astryxdesign/core/Button';
import {Link} from '@astryxdesign/core/Link';
import {SourcingContractReturnResponseSchema,SourcingTimelineEntrySchema} from '@dx-rework/contracts';
import {z} from 'zod';
import {createWebUrls} from '../url-contract.js';
import {DesignerOriginalShell} from './designer-original-shell.js';
import {useForegroundWait} from './foreground-loading.js';
import {sourcingReturnPath} from './sourcing-list-query.js';
import {useForegroundRead} from './use-foreground-read.js';

const urls=createWebUrls(import.meta.env.BASE_URL);
const directorySchema=z.object({
 contracts:z.array(SourcingTimelineEntrySchema.extend({kind:z.literal('contract'),pdfFilename:z.string().nullable(),pdfStatus:z.string().nullable()})),
 versions:SourcingContractReturnResponseSchema.shape.versions,
});
const attachment=(id:string,mode:'preview'|'download')=>urls.apiUrl(`tools/attachments/${id}/download?mode=${mode}`);
const dateTime=(value:string)=>new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});

export function SourcingContractOriginal({sourcingCaseId}:{sourcingCaseId:string}){
 const query=new URLSearchParams(window.location.search);
 const selected=z.string().uuid().safeParse(query.get('originalContract'));
 const target=selected.success&&query.getAll('originalContract').length===1?selected.data:null;
 const returnTo=sourcingReturnPath(window.location.search)??'/ui/sourcing/history';
 const load=useCallback(async(signal:AbortSignal)=>{
  const response=await fetch(urls.apiUrl(`sourcing/cases/${sourcingCaseId}/contract-directory`),{credentials:'include',cache:'no-store',signal});
  if(!response.ok)throw Error([401,403,404].includes(response.status)?'原合同不存在或不在当前授权范围。':'原合同读取失败，请重试。');
  return directorySchema.parse(await response.json());
 },[sourcingCaseId]);
 const read=useForegroundRead(sourcingCaseId,target,load);
 useForegroundWait(read.foregroundKey);
 const matching=read.value?.contracts.filter(item=>item.entryId===target);
 const contract=matching?.length===1?matching[0]:undefined;
 const signed=contract?read.value?.versions?.filter(version=>version.signedContractDocumentId===contract.entryId):undefined;
 return <DesignerOriginalShell title={contract?`系统合同 · 第 ${contract.version} 版 · 只读`:'系统合同原件'} onClose={()=>window.location.assign(urls.pageUrl(returnTo))}>
  {!target||read.value&&!contract?<p role="alert">找不到所选合同版本，请返回原单核对。</p>:
   read.error?<p role="alert">{read.error.message}<Button label="重新读取原合同" size="sm" onClick={read.retry}/></p>:
   contract?<>
    <dl aria-label="系统合同版本">
     <div><dt>合同编号</dt><dd>{contract.contractReference??'原记录未保存'}</dd></div>
     <div><dt>原加工厂</dt><dd>{contract.supplierName??'原记录未保存'}</dd></div>
     <div><dt>原生成时间</dt><dd>{dateTime(contract.handledAt)}</dd></div>
    </dl>
    {contract.pdfStatus==='ready'&&contract.pdfAttachmentId?<>
     <Link href={attachment(contract.pdfAttachmentId,'preview')} target="_blank" rel="noreferrer">预览所选合同 PDF</Link>{' '}
     <Link href={attachment(contract.pdfAttachmentId,'download')} target="_blank" rel="noreferrer">下载所选合同</Link>
    </>:<p>{contract.pdfAttachmentId?'所选版本的原 PDF 暂不可用。':'所选版本尚无原 PDF。'}</p>}
    <h3>本合同版本的回签</h3>
    {signed?.length?<ul>{signed.map(version=><li key={version.revision}>
     <p>第 {version.revision} 次 · {dateTime(version.submittedAt)} · {version.uploadedByName}</p>
     {version.attachments.map(file=><p key={file.attachmentId}><Link href={attachment(file.attachmentId,'preview')} target="_blank" rel="noreferrer">{file.filename}</Link></p>)}
    </li>)}</ul>:<p>{signed?'本版本无可见回签记录。':'原回签版本关系未提供。'}</p>}
   </>:<p role="status">正在读取所选合同原件…</p>}
 </DesignerOriginalShell>;
}
