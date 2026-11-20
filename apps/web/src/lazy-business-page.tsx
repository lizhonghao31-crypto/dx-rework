import {useForegroundWait} from './foreground-loading.js';
import {Children,Component,Suspense,isValidElement,lazy,useContext,type ComponentType,type ReactElement,type ReactNode} from 'react';
import {Shell,ShellPresenceContext} from './components.js';

function PendingBusinessModule(){
 useForegroundWait('opening-module');
 return <p role="status">正在打开页面…</p>;
}

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
type RouteElement=ReactElement<{children?:ReactNode}>;
const preloaders=new Map<unknown,()=>Promise<void>|undefined>();

/** Walk the existing route element, never mount its components or issue business reads. */
export function preloadBusinessRoute(route:ReactNode,allow:(element:RouteElement)=>boolean):Promise<void>|undefined{
 const work:Promise<void>[]=[];
 const visit=(tree:ReactNode)=>Children.forEach(tree,child=>{
  if(!isValidElement<RouteElement['props']>(child)||!allow(child))return;
  const preload=preloaders.get(child.type);
  if(!preload){visit(child.props.children);return;}
  const pending=preload();
  if(pending)work.push(pending);
 });
 visit(route);
 return work.length?Promise.all(work).then(()=>undefined):undefined;
}

type PageProps<Page> = Page extends (props:infer Props)=>ReactNode?NonNullable<Props> extends object?NonNullable<Props>:Record<never,never>:never;
export function lazyBusinessPage<PageType extends (props:never)=>ReactNode>(load:()=>Promise<{default:PageType}>,options:{shellOnError?:boolean}={}):ComponentType<PageProps<PageType>>{
 type Props=PageProps<PageType>;
 // Keep React component identity stable across parent renders. The local cast
 // only adapts LazyExoticComponent's ref type, never required caller props.
 let moduleRead:Promise<{default:ComponentType<Props>}>|undefined;
 let settled=false;
 const loadOnce=()=>moduleRead??=load().then(
  module=>({default:module.default as unknown as ComponentType<Props>}),
  cause=>{throw new BusinessModuleLoadError(cause);},
 ).finally(()=>{settled=true;});
 const Page=lazy(loadOnce);
 function DeferredBusinessPage(props:Props){
  const insideShell=useContext(ShellPresenceContext);
  const recoveryShell=!insideShell&&options.shellOnError!==false,loading=<PendingBusinessModule/>;
  return <ModuleLoadBoundary recoveryShell={recoveryShell}><Suspense fallback={recoveryShell?<Shell active="正在打开页面">{loading}</Shell>:loading}><Page {...props}/></Suspense></ModuleLoadBoundary>;
 }
 // A failed import still opens the original recovery UI at its own URL.
 preloaders.set(DeferredBusinessPage,()=>settled?undefined:loadOnce().then(()=>undefined,()=>undefined));
 return DeferredBusinessPage;
}
