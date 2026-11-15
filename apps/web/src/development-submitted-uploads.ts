import type {DevelopmentUploadPurpose} from '@dx-rework/contracts/digital-development-technical';

export type DevelopmentUploads=Partial<Record<DevelopmentUploadPurpose,string[]>>;
type SubmittedUploads={purposes:readonly DevelopmentUploadPurpose[];ids:string[]};
const purposes:Record<string,readonly DevelopmentUploadPurpose[]>={
 'technical/artifacts':['纸样成果','工艺开发板'],
 'technical/comments':['客户评语依据'],
 'technical/position':['定位图'],
 'technical/patch-complete':['尾查照片','补做成果'],
 complete:['纸样成果','工艺开发板'],
 route:['车板成果','尾查照片','工艺回样照片'],
 'fabric-reports':['面料报告'],
};
/** Select only references in the acknowledged command, never the current queue. */
export function submittedDevelopmentUploads(path:string,body:unknown):SubmittedUploads{
 const input=body&&typeof body==='object'?body as Record<string,unknown>:{};
 const used=path==='external-pattern'&&input.action==='receive'?['外部纸样'] as const:Object.hasOwn(purposes,path)?purposes[path]!:[];
 const artifact=input.body&&typeof input.body==='object'?input.body as Record<string,unknown>:{};
 const refs=path==='technical/artifacts'?artifact.pltAttachmentIds:path==='technical/comments'?input.evidenceRefs:input.attachmentIds;
 return {purposes:used,ids:used.length&&Array.isArray(refs)?[...new Set(refs.filter((id):id is string=>typeof id==='string'))]:[]};
}
/** Preserve unrelated purposes and files added after the submitted snapshot. */
export function settleDevelopmentUploads(current:DevelopmentUploads,submitted:SubmittedUploads):DevelopmentUploads{
 const saved=new Set(submitted.ids),next={...current};
 for(const purpose of submitted.purposes)if(current[purpose])next[purpose]=current[purpose]!.filter(id=>!saved.has(id));
 return next;
}
