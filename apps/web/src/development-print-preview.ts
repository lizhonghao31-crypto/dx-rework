import {useEffect,useRef,useState} from 'react';
import printStyles from './digital-development-print.css?inline';
import {paginateDevelopmentPrint} from './development-print-pages.js';
import {digitalRequest} from './digital-production-api.js';

type AttachmentMime=(id:string)=>Promise<string>;
const printableImage=/^image\/(?:jpeg|png|webp|gif)$/i;

export function developmentPrintAttachmentMime(pathFor:(id:string)=>string):AttachmentMime{
 return async id=>{
  const value=await digitalRequest<{attachmentId:string;mimeType:string}>(pathFor(id));
  if(value?.attachmentId!==id||typeof value.mimeType!=='string'||!value.mimeType)
   throw Error('未能核实本版工艺附件，请重新读取原单后再打印。');
  return value.mimeType;
 };
}

/** Use only the exact, already-read print section. The frame never mounts
 * business UI or executes a save, approval, or read-receipt action. */
export async function prepareDevelopmentPrint(source:HTMLElement,attachmentMime:AttachmentMime){
 const iframe=source.ownerDocument.createElement('iframe');
 iframe.title='版单 A4 打印预览';
 iframe.setAttribute('aria-hidden','true');iframe.tabIndex=-1;
 Object.assign(iframe.style,{position:'fixed',left:'-10000px',top:'0',width:'1123px',height:'794px',border:'0'});
 source.ownerDocument.body.append(iframe);
 const dispose=()=>iframe.remove();
 let timer:number|undefined;
 try{
  const target=iframe.contentDocument;
  if(!target||!iframe.contentWindow)throw Error('无法打开版单打印预览，请重试。');
  target.documentElement.lang='zh-CN';
  target.body.dataset.developmentPdf='true';
  const styles=target.createElement('style');styles.textContent=printStyles;target.head.append(styles);
  const clone=target.importNode(source,true);
  target.body.append(clone);
  const prepare=async()=>{
   const craft=Array.from(clone.querySelectorAll<HTMLElement>('[data-print-craft-image]')).filter(field=>!field.closest('[data-print-single-page]'));
   const mimes=new Map<string,Promise<string>>();
   // Resolve in the original document scope, without fetching unselected versions.
   for(const field of craft){
    const id=field.dataset.printCraftImage!,link=field.querySelector('a');
    if(!link)throw Error('原工艺附件链接不可读，未生成打印预览。');
    if(!mimes.has(id))mimes.set(id,attachmentMime(id));
    if(!printableImage.test(await mimes.get(id)!))continue;
    const img=target.createElement('img');
    img.src=link.href;img.alt=link.textContent??'工艺附图';img.dataset.printInlinedCraft='true';
    field.append(img);
   }
   await Promise.all([...clone.querySelectorAll('img')].map(async img=>{
    try{await img.decode();if(!img.naturalWidth)throw Error('IMAGE_EMPTY');}
    catch{throw Error(`${img.alt||'版单图片'}读取失败，未生成打印预览。请检查原附件后重试。`);}
   }));
   await target.fonts.ready;
   if([...target.fonts].some(font=>font.status==='error'))throw Error('版单字体未能加载，请重试打印。');
   paginateDevelopmentPrint(clone);
  };
  await Promise.race([prepare(),new Promise<never>((_,reject)=>{
   timer=window.setTimeout(()=>reject(Error('版单图片或字体暂未加载完成，未生成打印预览。请稍后重试。')),20000);
  })]);
  return {iframe,dispose};
 }catch(error){dispose();throw error;}
 finally{if(timer!==undefined)window.clearTimeout(timer);}
}

export function useDevelopmentPrint(){
 const ref=useRef<HTMLDivElement|null>(null),active=useRef<{iframe:HTMLIFrameElement;dispose:()=>void}|null>(null);
 const inFlight=useRef(false),live=useRef(true),[busy,setBusy]=useState(false),[error,setError]=useState('');
 useEffect(()=>{live.current=true;return()=>{live.current=false;active.current?.dispose();};},[]);
 const preview=async(attachmentMime:AttachmentMime)=>{
  const source=ref.current,selected=source?.dataset.printIdentity;
  if(!source||inFlight.current)return;
  inFlight.current=true;setBusy(true);setError('');
  active.current?.dispose();
  try{
   const prepared=await prepareDevelopmentPrint(source,attachmentMime);
   if(!live.current||ref.current!==source||source.dataset.printIdentity!==selected){prepared.dispose();return;}
   active.current=prepared;
   const target=prepared.iframe.contentWindow;
   if(!target)throw Error('未能打开打印预览，请重试。');
   target.addEventListener('afterprint',()=>{prepared.dispose();if(active.current===prepared)active.current=null;},{once:true});
   target.focus();target.print();
  }catch(reason){
   active.current?.dispose();active.current=null;
   if(live.current&&ref.current===source)setError(reason instanceof Error?reason.message:'版单打印失败，请重试。');
  }finally{inFlight.current=false;if(live.current)setBusy(false);}
 };
 return {ref,busy,error,preview};
}
