// @vitest-environment jsdom
import {act,createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {useDocumentUploadPreviews} from '../../apps/web/src/document-upload-previews.js';

let root:ReturnType<typeof createRoot>,container:HTMLDivElement,preview:ReturnType<typeof useDocumentUploadPreviews>;
beforeEach(async()=>{
 Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});
 vi.stubGlobal('URL',class extends URL{static createObjectURL=vi.fn(()=>`blob:TEST-${Math.random()}`);static revokeObjectURL=vi.fn();});
 container=document.createElement('div');document.body.append(container);root=createRoot(container);
 function Harness(){preview=useDocumentUploadPreviews();return createElement('div',null,preview.view);}
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
