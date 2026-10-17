export const taskTabLabels={handle:'当前办理',documents:'本单资料',history:'操作记录'} as const;
export const documentCategories=['development','instruction','budget','images','materials','results','customer','related'] as const;
export const documentChapterIds=['development-images','development-basic','development-materials','development-sizes','development-labels','development-craft','development-handling','budget-basic','budget-section-0','budget-section-1','budget-section-2','budget-summary','budget-outsourcing'] as const;
export const documentVersionKeys={development:'round',instruction:'instructionVersion',budget:'budgetVersion'} as const;
export function readDocumentVersion(kind:keyof typeof documentVersionKeys,search:string):number|undefined{const query=new URLSearchParams(search),key=documentVersionKeys[kind],value=query.get(key);return query.getAll(key).length===1&&value&&/^[1-9]\d*$/.test(value)&&Number.isSafeInteger(Number(value))?Number(value):undefined;}
export function readDocumentKind(search:string):keyof typeof documentVersionKeys|undefined{const query=new URLSearchParams(search),kind=query.get('documentKind');return query.getAll('documentKind').length===1&&kind&&Object.hasOwn(documentVersionKeys,kind)?kind as keyof typeof documentVersionKeys:undefined;}
export function isCurrentDocumentVersion(kind:keyof typeof documentVersionKeys,search:string):boolean{const query=new URLSearchParams(search),key=documentVersionKeys[kind];return query.getAll(key).length===1&&query.get(key)==='current';}
export type DocumentCategoryContext=typeof documentCategories[number];
type ContextPatch={taskTab?:keyof typeof taskTabLabels;documentCategory?:DocumentCategoryContext;documentChapter?:string|null;documentKind?:keyof typeof documentVersionKeys;round?:number|'current'|null;instructionVersion?:number|'current'|null;budgetVersion?:number|'current'|null};
export function readDigitalDetailContext(search:string){
 const query=new URLSearchParams(search),tab=query.get('taskTab'),category=query.get('documentCategory'),chapter=query.get('documentChapter');
 return {tab:query.getAll('taskTab').length===1&&tab&&Object.hasOwn(taskTabLabels,tab)?taskTabLabels[tab as keyof typeof taskTabLabels]:taskTabLabels.handle,category:query.getAll('documentCategory').length===1&&documentCategories.includes(category as DocumentCategoryContext)?category as DocumentCategoryContext:'development' as const,chapter:query.getAll('documentChapter').length===1&&documentChapterIds.includes(chapter as typeof documentChapterIds[number])?chapter as typeof documentChapterIds[number]:undefined};
}
/** Only navigation presentation is stored here; no business fields, roles or input drafts. */
export function rememberDigitalDetailContext(patch:ContextPatch){
 const url=new URL(window.location.href);
 for(const [key,value]of Object.entries(patch)){if(value===null)url.searchParams.delete(key);else if(value!==undefined&&(key!=='documentChapter'||(documentChapterIds as readonly string[]).includes(String(value))))url.searchParams.set(key,String(value));}
 window.history.replaceState(window.history.state,'',url);
}
