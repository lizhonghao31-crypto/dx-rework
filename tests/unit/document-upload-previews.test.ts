// @vitest-environment jsdom
import {act,createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {useDocumentUploadPreviews} from '../../apps/web/src/document-upload-previews.js';

let root:ReturnType<typeof createRoot>,container:HTMLDivElement,preview:ReturnType<typeof useDocumentUploadPreviews>;
const removed=vi.fn();
beforeEach(async()=>{
 removed.mockReset();
 Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});
 vi.stubGlobal('URL',class extends URL{static createObjectURL=vi.fn(()=>`blob:TEST-${Math.random()}`);static revokeObjectURL=vi.fn();});
 container=document.createElement('div');document.body.append(container);root=createRoot(container);
 function Harness(){preview=useDocumentUploadPreviews({onFailureRemoved:removed});return createElement('div',null,preview.view);}
 await act(async()=>root.render(createElement(Harness)));
});
afterEach(async()=>{await act(async()=>root.unmount());container.remove();vi.unstubAllGlobals();});
it('keeps a failed file retryable and pending after an acknowledged sibling is saved',async()=>{
 const saved=new File(['TEST'],'saved.plt'),failed=new File(['TEST'],'failed.plt'),retry=vi.fn();
 await act(async()=>{preview.start([saved,failed],'纸样成果',retry);preview.uploaded(saved,'saved-ref');preview.failed(failed,'TEST upload rejected');});
 await act(async()=>preview.saved(['saved-ref'],['纸样成果']));
 expect(preview.pending).toBe(true);expect(preview.unready).toBe(true);expect(container.textContent).not.toContain('saved.plt');expect(container.textContent).toContain('failed.plt');expect(container.textContent).toContain('TEST upload rejected');
 await act(async()=>container.querySelector('button')!.click());expect(retry).toHaveBeenCalledWith([failed]);
 await act(async()=>preview.uploaded(failed,'retried-ref'));expect(preview.pending).toBe(true);expect(preview.unready).toBe(false);
 await act(async()=>preview.saved(['retried-ref'],['纸样成果']));expect(preview.pending).toBe(false);expect(preview.unready).toBe(false);
});
it('preserves the other purpose preview even if it references the same stored file',async()=>{
 const paper=new File(['TEST'],'paper.plt'),position=new File(['TEST'],'position.pdf');
 await act(async()=>{preview.start([paper],'纸样成果');preview.start([position],'定位图');preview.uploaded(paper,'shared-ref');preview.uploaded(position,'shared-ref');});
 await act(async()=>preview.saved(['shared-ref'],['纸样成果']));
 expect(container.textContent).not.toContain('paper.plt');expect(container.textContent).toContain('position.pdf');expect(preview.pending).toBe(true);
});
it('removes only an explicitly discarded failed local file and keeps ready references and in-flight files',async()=>{
 const failed=new File(['TEST'],'rejected.plt'),ready=new File(['TEST'],'ready.png'),pending=new File(['TEST'],'pending.png');
 await act(async()=>{preview.start([failed,ready,pending],'外部纸样');preview.failed(failed,'TEST invalid format');preview.uploaded(ready,'original-ready-ref');});
 expect(container.querySelectorAll('[aria-label^="移除失败附件 "]')).toHaveLength(1);
 const revocations=vi.mocked(URL.revokeObjectURL).mock.calls.length;
 await act(async()=>container.querySelector<HTMLButtonElement>('[aria-label="移除失败附件 rejected.plt"]')!.click());
 expect(container.textContent).not.toContain('rejected.plt');expect(container.textContent).toContain('ready.png');expect(container.textContent).toContain('pending.png');
 expect(removed).toHaveBeenCalledExactlyOnceWith('TEST invalid format');expect(URL.revokeObjectURL).toHaveBeenCalledTimes(revocations+1);
 await act(async()=>{preview.removeFailed(ready);preview.removeFailed(pending);});
 expect(removed).toHaveBeenCalledTimes(1);expect(preview.pending).toBe(true);expect(preview.unready).toBe(true);expect(preview.identity('original-ready-ref')?.filename).toBe('ready.png');
});
it('settles only the original failure snapshot for the completed task and purpose',async()=>{
 const original=new File(['TEST'],'original.plt'),otherTask=new File(['TEST'],'other-task.plt'),otherPurpose=new File(['TEST'],'other-purpose.plt'),later=new File(['TEST'],'later.plt');
 await act(async()=>{preview.start([original],'外部纸样',undefined,'task-a');preview.start([otherTask],'外部纸样',undefined,'task-b');preview.start([otherPurpose],'定位图',undefined,'task-a');for(const file of [original,otherTask,otherPurpose])preview.failed(file,'TEST rejected');});
 const snapshot=preview.failedSnapshot(['外部纸样'],'task-a');expect(snapshot).toHaveLength(1);
 await act(async()=>{preview.start([later],'外部纸样',undefined,'task-a');preview.failed(later,'TEST later rejected');preview.settleFailures(snapshot);});
 expect(container.textContent).not.toContain('original.plt');for(const name of ['other-task.plt','other-purpose.plt','later.plt'])expect(container.textContent).toContain(name);
 expect(removed).not.toHaveBeenCalled();expect(preview.unready).toBe(true);
});
it('does not discard a newer retry or a ready reference using an old completed-task snapshot',async()=>{
 const retried=new File(['TEST'],'retry.plt'),ready=new File(['TEST'],'ready.png');
 await act(async()=>{preview.start([retried,ready],'外部纸样',undefined,'task-a');preview.failed(retried,'TEST first failure');preview.failed(ready,'TEST first failure');});
 const snapshot=preview.failedSnapshot(['外部纸样'],'task-a');
 await act(async()=>{preview.start([retried],'外部纸样',undefined,'task-a');preview.failed(retried,'TEST second failure');preview.uploaded(ready,'ready-after-snapshot');preview.settleFailures(snapshot);});
 expect(container.textContent).toContain('TEST second failure');expect(preview.identity('ready-after-snapshot')?.filename).toBe('ready.png');
 expect(preview.pending).toBe(true);expect(preview.unready).toBe(true);
 await act(async()=>preview.settleFailures(preview.failedSnapshot(['外部纸样'],'task-a')));
 expect(preview.pending).toBe(true);expect(preview.unready).toBe(false);expect(preview.identity('ready-after-snapshot')).toBeDefined();
});
