import {afterEach,describe,expect,it,vi} from 'vitest';
import {bulkCuttingDetailHref,digitalChildDetailHref,digitalDetailClosePath,digitalDetailReturnUrl,digitalDetailRoute,productionWorkspaceDomainHref} from '../../apps/web/src/digital-detail-route.js';
import {isCurrentDocumentVersion,readDocumentKind,readDocumentVersion,readDigitalDetailContext,rememberDigitalDetailContext} from '../../apps/web/src/digital-detail-context.js';
import {cuttingReturnPath} from '../../apps/web/src/cutting-query.js';
import {sourcingNavigationView,sourcingReturnPath,withSourcingOrigin} from '../../apps/web/src/sourcing-list-query.js';
const order='00000000-0000-4000-8000-000000000001',line='00000000-0000-4000-8000-000000000002',task='00000000-0000-4000-8000-000000000003',history='00000000-0000-4000-8000-000000000004';
const url=(value:string)=>new URL(value,'https://local.invalid');
const detail=(kind:string,id:string,extra:Record<string,string>={})=>'/ui/digital-production?'+new URLSearchParams({[kind]:id,...extra});
afterEach(()=>vi.unstubAllGlobals());
describe('existing source and presentation context survive native detail hops',()=>{
 it.each(['/','/acceptance/'])('keeps an ordinary filtered cockpit without workspace and prefixes base once: %s',base=>{
  const current=`/ui/digital-cockpit?search=TEST&page=3&selected=${order}&stage=preparation`;
  const next=url(productionWorkspaceDomainHref(`/ui/digital-production?bulk=${order}`,url(current).search,base,base+'ui/digital-cockpit'));
  expect(next.pathname).toBe(base+'ui/digital-production');
  const back=url(next.searchParams.get('returnTo')!);expect(back.pathname).toBe(base+'ui/digital-cockpit');
  for(const [key,value]of Object.entries({search:'TEST',page:'3',selected:order,stage:'preparation'}))expect(back.searchParams.get(key)).toBe(value);
  expect(next.href).not.toContain('/acceptance/acceptance/');
 });
 it.each(['/','/acceptance/'])('returns cutting to the exact bulk PO, then its original board: %s',base=>{
  const board=`/ui/digital-cockpit?workspace=preparation&search=TEST&page=2&selected=${order}`;
  const target=bulkCuttingDetailHref('/ui/cutting/orders/'+history,order,line,url(board).search,base,base+'ui/digital-cockpit');
  const back=cuttingReturnPath(url(target).search,base),parent=url(back);expect(parent.searchParams.get('bulk')).toBe(order);expect(parent.searchParams.get('line')).toBe(line);
  const returned=url(digitalDetailClosePath(parent.search,base)!);expect(returned.pathname).toBe(base+'ui/digital-cockpit');expect(returned.searchParams.get('page')).toBe('2');
  const again=bulkCuttingDetailHref(base+'ui/cutting/orders/'+history,order,line,parent.search,base,base+'ui/digital-production');
  expect(url(url(again).searchParams.get('returnTo')!).searchParams.get('returnTo')).toBe(parent.searchParams.get('returnTo'));
 });
 it.each(['/','/acceptance/'])('preserves legal compound sources by the existing active-domain priority: %s',base=>{
  const source=detail('development',order,{round:'2',task,taskView:'read'});
  const back=digitalDetailReturnUrl(source,base);expect(back).not.toBeNull();expect(digitalDetailRoute(url(back!).search)).toEqual({kind:'development',id:order,version:2});
  const child=url(productionWorkspaceDomainHref(`/ui/digital-production?task=${history}&taskView=read`,url(source).search,base,base+'ui/digital-production'));
  expect(digitalDetailClosePath(child.search,base)).toBe(back);expect(digitalDetailRoute(url(digitalDetailClosePath(url(back!).search,base)!).search)).toEqual({kind:'task',id:task});
  expect(digitalDetailReturnUrl(detail('development',order,{round:'2',task:'bad'}),base)).toBeNull();
  expect(digitalDetailReturnUrl(source+'&task='+history,base)).toBeNull();
  expect(digitalDetailReturnUrl(detail('development',order,{round:'2',task,returnTo:source}),base)).toBeNull();
 });
 it('keeps bulk, factory PO/action, instruction version and exact parent through a second hop',()=>{
  const factory=detail('factory',order,{factoryAction:'qc',line,returnTo:'/ui/my-tasks?page=2'});
  const instruction=url(productionWorkspaceDomainHref(`/ui/digital-production?instruction=${order}&instructionVersion=3`,url(factory).search,'/','/ui/digital-production'));
  const budget=url(productionWorkspaceDomainHref(`/ui/digital-production?budget=${order}&budgetVersion=2`,instruction.search,'/','/ui/digital-production'));
  expect(digitalDetailClosePath(budget.search,'/')).toBe(instruction.pathname+instruction.search);
  const parent=url(digitalDetailClosePath(instruction.search,'/')!);expect(parent.searchParams.get('factoryAction')).toBe('qc');expect(parent.searchParams.get('line')).toBe(line);expect(digitalDetailClosePath(parent.search,'/')).toBe('/ui/my-tasks?page=2');
 });
 it('opens an inherited task read-only and restores current task documents/chapter and original todo',()=>{
  const source=detail('task',task,{taskView:'handle',workbench:'sample',taskTab:'documents',documentCategory:'development',documentChapter:'development-handling',round:'1',returnTo:'/ui/my-tasks?q=TEST&page=3'});
  const inherited=url(productionWorkspaceDomainHref(`/ui/digital-production?task=${history}&taskView=read`,url(source).search,'/','/ui/digital-production'));
  expect(inherited.searchParams.get('taskView')).toBe('read');
  const current=url(digitalDetailClosePath(inherited.search,'/')!);expect(current.searchParams.get('task')).toBe(task);expect(readDocumentVersion('development',current.search)).toBe(1);expect(readDigitalDetailContext(current.search)).toEqual({tab:'本单资料',category:'development',chapter:'development-handling'});
  expect(digitalDetailReturnUrl(inherited.pathname+inherited.search,'/')).toBe(inherited.pathname+inherited.search);
  expect(digitalDetailClosePath(current.search,'/')).toBe('/ui/my-tasks?q=TEST&page=3');
 });
 it('preserves actual pattern aliases and distinct historical rounds without permitting a cycle',()=>{
  const board=`/acceptance/ui/digital-cockpit?workspace=pattern&scope=mine&lane=sewing&page=2&task=${task}&taskTab=history`;
  expect(digitalDetailReturnUrl(board,'/acceptance/')).toBe(board);
  const earlier=detail('development',order,{round:'1'}),later=detail('development',order,{round:'2',returnTo:earlier});
  expect(digitalDetailReturnUrl(later,'/')).toBe(later);
  expect(digitalDetailReturnUrl(detail('development',order,{round:'2',returnTo:later}),'/')).toBeNull();
 });
 it('ignores malformed presentation context and rejects unsafe/ambiguous/deep sources',()=>{
  expect(readDigitalDetailContext('?taskTab=toString&documentCategory=unknown&documentChapter=unknown')).toEqual({tab:'当前办理',category:'development',chapter:undefined});
  expect(readDigitalDetailContext('?taskTab=history&taskTab=documents&documentCategory=budget&documentCategory=images&documentChapter=budget-basic&documentChapter=budget-summary')).toEqual({tab:'当前办理',category:'development',chapter:undefined});
  for(const value of ['https://outside.test/ui/digital-production?order='+order,'//outside.test/','/\\outside.test',detail('bulk','bad'),detail('factory',order,{factoryAction:'write'}),detail('task',task,{taskTab:'toString'}),detail('task',task,{round:'0'}),detail('budget',order,{budgetVersion:'0'}),detail('bulk',order,{line:'bad'}),detail('task',task,{taskView:'handle',returnTo:detail('task',history)}),detail('order',order)+'&order='+line,detail('order',order,{extra:'unexpected'})])expect(digitalDetailReturnUrl(value,'/')).toBeNull();
  let nested='/ui/my-tasks';for(let i=0;i<5;i++)nested=detail('budget',order,{budgetVersion:String(i+1),returnTo:nested});expect(digitalDetailReturnUrl(nested,'/')).toBeNull();
  expect(digitalChildDetailHref('https://outside.test/','/ui/my-tasks','/')).toBe('');
 });
 it('keeps explicit current document context separate from adopted/history versions',()=>{
  const current=detail('task',task,{taskTab:'documents',documentKind:'budget',documentCategory:'materials',budgetVersion:'current',round:'1'});
  expect(digitalDetailReturnUrl(current,'/')).toBe(current);expect(readDocumentKind(url(current).search)).toBe('budget');expect(isCurrentDocumentVersion('budget',url(current).search)).toBe(true);expect(readDocumentVersion('development',url(current).search)).toBe(1);
  expect(digitalDetailReturnUrl(detail('budget',order,{budgetVersion:'current'}),'/')).toBeNull();expect(digitalDetailReturnUrl(detail('task',task,{documentKind:'toString'}),'/')).toBeNull();
 });
 it('remembers only presentation without losing router state or unrelated current identity',()=>{
  let href='https://local.invalid/acceptance/ui/digital-production?task='+task+'&taskView=read&todo='+history;
  const state={dxInternalNavigationPosition:7,dxInternalRestoreScroll:{top:120}};
  vi.stubGlobal('window',{location:{get href(){return href;}},history:{state,replaceState:vi.fn((next:unknown,_title:string,target:URL)=>{expect(next).toBe(state);href=String(target);})}});
  rememberDigitalDetailContext({taskTab:'documents',documentCategory:'budget',documentChapter:'budget-summary'});
  expect(url(href).searchParams.get('taskView')).toBe('read');expect(url(href).searchParams.get('todo')).toBe(history);expect(readDigitalDetailContext(url(href).search).chapter).toBe('budget-summary');
  rememberDigitalDetailContext({documentChapter:null});expect(url(href).searchParams.has('documentChapter')).toBe(false);
 });
 it.each(['/','/acceptance/'])('carries a validated digital budget origin through sourcing without changing history selection: %s',base=>{
  const source=base+'ui/digital-production?'+new URLSearchParams({budget:order,budgetVersion:'2',documentCategory:'budget',documentChapter:'budget-summary',returnTo:'/ui/my-tasks?page=3'});
  const created=url(withSourcingOrigin(base+'ui/sourcing/orders/'+history,source,base));
  const back=sourcingReturnPath(created.search,base)!;expect(back.startsWith('/ui/digital-production?')).toBe(true);expect(url(back).searchParams.get('budgetVersion')).toBe('2');expect(url(back).searchParams.get('documentChapter')).toBe('budget-summary');
  const historyReturn='?'+new URLSearchParams({returnTo:'/ui/sourcing/history?q=TEST&page=4'});expect(sourcingNavigationView('detail',historyReturn)).toBe('history');expect(sourcingNavigationView('detail',created.search)).toBe('pending');
  expect(sourcingNavigationView('create',historyReturn)).toBe('create');
  for(const target of ['https://[','https://outside.test/ui/digital-production?budget='+order,'/ui/my-tasks',detail('budget','bad')])expect(sourcingReturnPath('?'+new URLSearchParams({returnTo:target}),base)).toBeNull();
  expect(sourcingNavigationView('detail',historyReturn+'&returnTo=%2Fui%2Fsourcing%2Fpending')).toBe('pending');
 });
});
