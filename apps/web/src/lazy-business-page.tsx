import {Component,Suspense,lazy,useContext,type ComponentType,type ReactNode} from 'react';
import {Shell,ShellPresenceContext} from './components.js';

class BusinessModuleLoadError extends Error{
 constructor(cause:unknown){super('Business module load failed',{cause});}
}
class ModuleLoadBoundary extends Component<{children:ReactNode;recoveryShell:boolean},{failed:boolean}>{
 override state={failed:false};
 static getDerivedStateFromError(error:unknown){
  // A business rendering error is not re-labelled as a network/resource failure.
  if(!(error instanceof BusinessModuleLoadError))throw error;
  return {failed:true};
 }
 override render(){
  if(!this.state.failed)return this.props.children;
  const message=<section role="alert" className="dx-surface"><p>页面暂时未能打开，请刷新重试。</p><button type="button" onClick={()=>window.location.reload()}>刷新页面</button></section>;
  return this.props.recoveryShell?<Shell active="页面暂未打开">{message}</Shell>:message;
 }
}
/** Called only where the original authorized page renders. A browser keeps a
 * failed module fetch in its document module map. Recovery is an explicit page
 * refresh, never a misleading same-URL import retry or automatic reload.
 */
type PageProps<Page> = Page extends (props:infer Props)=>ReactNode?NonNullable<Props> extends object?NonNullable<Props>:Record<never,never>:never;
export function lazyBusinessPage<PageType extends (props:never)=>ReactNode>(load:()=>Promise<{default:PageType}>,options:{shellOnError?:boolean}={}):ComponentType<PageProps<PageType>>{
 type Props=PageProps<PageType>;
 // Keep React component identity stable across parent renders. The local cast
 // only adapts LazyExoticComponent's ref type, never required caller props.
 const Page=lazy(async()=>{try{const module=await load();return {default:module.default as unknown as ComponentType<Props>};}catch(error){throw new BusinessModuleLoadError(error);}});
 return function DeferredBusinessPage(props:Props){
  const insideShell=useContext(ShellPresenceContext);
  const recoveryShell=!insideShell&&options.shellOnError!==false,loading=<p role="status">正在打开页面…</p>;
  return <ModuleLoadBoundary recoveryShell={recoveryShell}><Suspense fallback={recoveryShell?<Shell active="正在打开页面">{loading}</Shell>:loading}><Page {...props}/></Suspense></ModuleLoadBoundary>;
 };
}
