/** Lay out actual A4 pages before invoking print. Every document starts at a
 * new page, repeats its own identity and receives independent page numbers. */
export function paginateDevelopmentPrint(root:HTMLElement){
 const document=root.ownerDocument;
 const originals=Array.from(root.querySelectorAll<HTMLElement>(':scope > [data-print-document]'));
 if(!originals.length)throw Error('没有可打印的原版单。');
 const identity=root.dataset.printPageIdentity??'';
 root.replaceChildren();
 for(const original of originals){
  const name=original.dataset.printDocument!;
  const pages:{page:HTMLElement;flow:HTMLElement;number:HTMLSpanElement}[]=[];
  const newPage=()=>{
   const page=document.createElement('section');
   page.className='development-print-page';
   page.dataset.printDocument=name;
   if(original.dataset.garmentLayout)page.dataset.garmentLayout=original.dataset.garmentLayout;
   if(pages.length){
    const title=document.createElement('header');
    title.className='development-print-page__continued';
    title.textContent=`${name} · ${identity}`;
    page.append(title);
   }
   const flow=document.createElement('div');
   flow.className='development-print-page__content';
   const footer=document.createElement('footer'),caption=document.createElement('span'),number=document.createElement('span');
   footer.className='development-print-page__caption';
   caption.textContent=identity;
   number.textContent=`${name} · 第 000 / 000 页`;
   footer.append(caption,number);
   page.append(flow,footer);
   root.append(page);
   const result={page,flow,number};
   pages.push(result);
   return result;
  };
  let current=newPage();
  const fits=()=>current.flow.scrollHeight<=current.flow.clientHeight+1;
  const tryAppend=(element:HTMLElement)=>{
   current.flow.append(element);
   if(fits())return true;
   element.remove();
   return false;
  };
  const appendText=(block:HTMLElement)=>{
   const text=block.querySelector('p');
   if(!text)throw Error(`${name}文字区域缺少原内容，未生成打印预览。`);
   let rest=Array.from(text.textContent??'');
   const copy=(length:number)=>{
    const fragment=block.cloneNode(true) as HTMLElement;
    fragment.querySelector('p')!.textContent=rest.slice(0,length).join('');
    return fragment;
   };
   while(rest.length){
    let low=1,high=rest.length,best=0;
    while(low<=high){
     const mid=Math.floor((low+high)/2),sample=copy(mid);
     if(tryAppend(sample)){sample.remove();best=mid;low=mid+1;}else high=mid-1;
    }
    if(!best){
     if(!current.flow.children.length)throw Error(`${name}文字超出纸张范围，未省略原内容。`);
     current=newPage();
     continue;
    }
    current.flow.append(copy(best));
    rest=rest.slice(best);
    if(rest.length)current=newPage();
   }
  };
  const appendTable=(block:HTMLElement)=>{
   const originalTable=block.querySelector<HTMLTableElement>('[data-print-table]');
   if(!originalTable||!originalTable.tBodies.length)throw Error(`${name}明细读取失败，未生成打印预览。`);
   const rows=Array.from(originalTable.tBodies[0]!.rows);
   const copy=()=>{
    const fragment=block.cloneNode(true) as HTMLElement;
    const table=fragment.querySelector<HTMLTableElement>('[data-print-table]')!;
    while(table.nextElementSibling)table.nextElementSibling.remove();
    const body=table.tBodies[0]!;
    body.replaceChildren();
    return {fragment,body,table};
   };
   const tail=Array.from(block.children).slice(Array.from(block.children).indexOf(originalTable)+1) as HTMLElement[];
   let table=copy();
   current.flow.append(table.fragment);
   for(const row of rows){
    const detail=row.cloneNode(true) as HTMLTableRowElement;
    table.body.append(detail);
    if(fits())continue;
    detail.remove();
    if(!table.body.rows.length)table.fragment.remove();
    if(!current.flow.children.length)throw Error(`${name}有一行明细超出单张纸，未裁切原明细。`);
    current=newPage();table=copy();current.flow.append(table.fragment);table.body.append(detail);
    if(!fits())throw Error(`${name}有一行明细超出单张纸，未裁切原明细。`);
   }
   for(const element of tail){
    if(tryAppend(element))continue;
    current=newPage();
    if(!tryAppend(element))throw Error(`${name}有一条记录超出纸张范围，未省略原记录。`);
   }
  };
  const contents=Array.from(original.children) as HTMLElement[];
  for(let index=0;index<contents.length;index++){
   const element=contents[index]!;
   if(element.hasAttribute('data-print-feedback-image')){
    const pageBounds=current.flow.getBoundingClientRect();
    const previous=current.flow.lastElementChild?.getBoundingClientRect();
    const remaining=pageBounds.bottom-(previous?.bottom??pageBounds.top);
    if(current.flow.querySelector('[data-print-feedback-image], [data-print-feedback-pair]')||remaining<pageBounds.height*.73)current=newPage();
    const available=current.flow.getBoundingClientRect();
    const before=current.flow.lastElementChild?.getBoundingClientRect();
    const height=available.bottom-(before?.bottom??available.top)-6;
    const next=contents[index+1];
    if(next?.hasAttribute('data-print-feedback-image')){
     // Pair only if both can be printed at or above native geometry in
     // the A4 columns. Never downscale details merely to fit two on a page.
     const width=(available.width-22)/2,photoHeight=height-66;
     const nativeFit=(image:HTMLImageElement|null)=>image&&image.naturalWidth>=320&&image.naturalHeight>=225
      &&width>=image.naturalWidth&&photoHeight>=image.naturalHeight;
     if(nativeFit(element.querySelector('img'))&&nativeFit(next.querySelector('img'))){
      const group=document.createElement('section');
      group.className='development-feedback-pair';group.dataset.printFeedbackPair='true';group.style.height=`${Math.floor(height)}px`;
      const title=element.querySelector('h3')!.cloneNode(true),pictures=document.createElement('div');
      pictures.append(element,next);group.append(title,pictures);
      if(tryAppend(group)){index++;continue;}
      // Fallback keeps the two original nodes and their original image order.
      pictures.replaceChildren();
     }
    }
    element.style.height=`${Math.floor(height)}px`;
    if(!tryAppend(element))throw Error('客户评语原图未能完整排入纸张，未生成打印预览。');
    const img=element.querySelector('img')!;
    const scale=Math.min(img.clientWidth/img.naturalWidth,img.clientHeight/img.naturalHeight);
    if(scale>1.45){
     const caption=element.querySelector('figcaption')!;
     caption.textContent+= ' · 原图分辨率有限，小字请核对原件';
    }
    continue;
   }
   if(tryAppend(element))continue;
   if(original.dataset.printSinglePage==='true')throw Error('版单摘要超出原 A4 横向范围，未生成不完整打印。请查看本版本在线资料。');
   if(element.hasAttribute('data-print-split-text')&&element.querySelector('p')?.textContent){appendText(element);continue;}
   if(element.hasAttribute('data-print-split-table')){appendTable(element);continue;}
   if(current.flow.children.length)current=newPage();
   if(!tryAppend(element))throw Error(`${name}有内容超出纸张范围，未裁切原内容。`);
  }
  for(const [index,page] of pages.entries())page.number.textContent=`${name} · 第 ${index+1} / ${pages.length} 页`;
 }
}
