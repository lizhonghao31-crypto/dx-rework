// @vitest-environment jsdom
import {act,createElement} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {CockpitPhoto,cockpitImagePreviewPath} from '../../apps/web/src/cockpit-photo-preview.js';
const id='00000000-0000-4000-8000-000000000001',src=`/api/digital-production/sources/${id}/development/attachments/${id}`;
let root:Root,host:HTMLDivElement;
beforeEach(()=>{Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});host=document.createElement('div');document.body.append(host);root=createRoot(host);Object.assign(HTMLDialogElement.prototype,{showModal(){this.open=true;},close(){this.open=false;this.dispatchEvent(new Event('close'));}});});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.restoreAllMocks();});
const render=async(value=src)=>act(async()=>root.render(createElement(CockpitPhoto,{src:value,label:'TEST'})));
it('uses protected independent previews only for the two existing image routes and leaves arbitrary/external URLs alone',()=>{
 expect(cockpitImagePreviewPath(src)).toBe(src+'/preview');
 const instruction=`/api/digital-production/orders/${id}/instruction/attachments/${id}`;expect(cockpitImagePreviewPath(instruction)).toBe(instruction+'/preview');
 for(const value of ['https://example.invalid/original.png','/api/other-file/'+id,src+'?version=1'])expect(cockpitImagePreviewPath(value)).toBe(value);
});
it('loads small images lazily with stable dimensions and opens only the original full image on demand',async()=>{
 await render();const image=host.querySelector('img')!;expect(image.getAttribute('src')).toBe(src+'/preview');expect(image.getAttribute('loading')).toBe('lazy');expect(image.getAttribute('decoding')).toBe('async');expect(image.getAttribute('width')).toBe('320');
 expect(host.querySelector('dialog img')).toBeNull();await act(async()=>host.querySelector('button')!.click());
 expect(host.querySelector('dialog img')!.getAttribute('src')).toBe(src);
});
it('falls back once to the original after preview failure, then keeps an explicit failed state without an automatic retry loop',async()=>{
 await render();await act(async()=>host.querySelector('img')!.dispatchEvent(new Event('error')));expect(host.querySelector('img')!.getAttribute('src')).toBe(src);
 await act(async()=>host.querySelector('img')!.dispatchEvent(new Event('error')));expect(host.querySelector('img')!.hidden).toBe(true);expect(host.textContent).toContain('加载失败');
 const other=src.replace('/sources/','/orders/').replace('/development/','/instruction/');await render(other);expect(host.querySelector('img')!.getAttribute('src')).toBe(other+'/preview');expect(host.querySelector('img')!.hidden).toBe(false);
});
