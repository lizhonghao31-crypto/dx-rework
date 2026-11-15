import {expect,it} from 'vitest';
import {submittedDevelopmentUploads,settleDevelopmentUploads,type DevelopmentUploads} from '../../apps/web/src/development-submitted-uploads.js';

it('settles the paper references actually saved in a technical version and keeps later uploads pending',()=>{
 const current:DevelopmentUploads={'纸样成果':['saved-plt','later-plt'],'定位图':['other-position']},snapshot=structuredClone(current);
 const next=settleDevelopmentUploads(current,submittedDevelopmentUploads('technical/artifacts',{body:{pltAttachmentIds:['saved-plt','already-stored-plt']}}));
 expect(next).toEqual({'纸样成果':['later-plt'],'定位图':['other-position']});expect(current).toEqual(snapshot);
});
it('clears acknowledged sewing, tail and craft-return references without erasing another pending result',()=>{
 const current:DevelopmentUploads={'车板成果':['sewing'],'尾查照片':['tail'],'工艺回样照片':['craft']};
 expect(settleDevelopmentUploads(current,submittedDevelopmentUploads('route',{attachmentIds:['sewing']}))).toEqual({'车板成果':[],'尾查照片':['tail'],'工艺回样照片':['craft']});
});
it('does not consume uploads when a completion carries only an existing artifact reference',()=>{
 const current:DevelopmentUploads={'纸样成果':['not-submitted']};
 expect(settleDevelopmentUploads(current,submittedDevelopmentUploads('complete',{artifactRef:{id:'stored',version:1},attachmentIds:[]}))).toEqual(current);
});
it.each([
 ['complete','纸样成果','attachmentIds'],['technical/comments','客户评语依据','evidenceRefs'],
 ['technical/position','定位图','attachmentIds'],['technical/patch-complete','补做成果','attachmentIds'],
 ['fabric-reports','面料报告','attachmentIds'],['external-pattern','外部纸样','attachmentIds'],
] as const)('settles %s only in its own purpose after a confirmed response',(path,purpose,field)=>{
 const current:DevelopmentUploads={[purpose]:['confirmed'],'工艺回样照片':['confirmed']};
 const next=settleDevelopmentUploads(current,submittedDevelopmentUploads(path,{action:'receive',[field]:['confirmed']}));
 expect(next[purpose]).toEqual([]);expect(next['工艺回样照片']).toEqual(['confirmed']);
});
it('ignores request-only external paper actions and unrelated commands carrying attachment-like fields',()=>{
 const current:DevelopmentUploads={'外部纸样':['unsaved']};
 for(const [path,body] of [['external-pattern',{action:'request',attachmentIds:['unsaved']}],['dispatch',{attachmentIds:['unsaved']}],['toString',{attachmentIds:['unsaved']}]] as const)
  expect(settleDevelopmentUploads(current,submittedDevelopmentUploads(path,body))).toEqual(current);
});
