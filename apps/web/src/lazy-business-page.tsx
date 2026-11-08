import {Component,Suspense,lazy,type ComponentType,type ReactNode} from 'react';

// The original main styles follow page styles in the cascade. Vite appends
// lazy CSS links later; retain that original common-style order after a load
// without downloading every other business module's CSS up front.
const sharedStyles=typeof document==='undefined'?[]:[...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')];
const preserveCommonStyleOrder=()=>{for(const sheet of sharedStyles)if(sheet.isConnected)sheet.parentNode?.appendChild(sheet);};

class BusinessModuleLoadError extends Error{
 constructor(cause:unknown){super('Business module load failed',{cause});}
}
class ModuleLoadBoundary extends Component<{children:ReactNode},{failed:boolean}>{
 override state={failed:false};
 static getDerivedStateFromError(error:unknown){
  // A business rendering error is not re-labelled as a network/resource failure.
  if(!(error instanceof BusinessModuleLoadError))throw error;
  return {failed:true};
 }
 override render(){
  if(!this.state.failed)return this.props.children;
  return <section role="alert" className="dx-surface"><p>页面暂时未能打开，请刷新重试。</p><button type="button" onClick={()=>window.location.reload()}>刷新页面</button></section>;
 }
}
/** Called only where the original authorized page renders. A browser keeps a
 * failed module fetch in its document module map. Recovery is an explicit page
 * refresh, never a misleading same-URL import retry or automatic reload.
 */
type PageProps<Page> = Page extends (props:infer Props)=>ReactNode?NonNullable<Props> extends object?NonNullable<Props>:Record<never,never>:never;
export function lazyBusinessPage<PageType extends (props:never)=>ReactNode>(load:()=>Promise<{default:PageType}>):ComponentType<PageProps<PageType>>{
 type Props=PageProps<PageType>;
 // Keep React component identity stable across parent renders. The local cast
 // only adapts LazyExoticComponent's ref type, never required caller props.
 const Page=lazy(async()=>{try{const module=await load();preserveCommonStyleOrder();return {default:module.default as unknown as ComponentType<Props>};}catch(error){preserveCommonStyleOrder();throw new BusinessModuleLoadError(error);}});
 return function DeferredBusinessPage(props:Props){
  return <ModuleLoadBoundary><Suspense fallback={<p role="status">正在打开页面…</p>}><Page {...props}/></Suspense></ModuleLoadBoundary>;
 };
}
