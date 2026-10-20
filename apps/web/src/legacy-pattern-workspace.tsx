import {useEffect,useState} from 'react';
import {verifySession,type AuthorizedUser} from './auth.js';
import {PatternRoomOrdersPage} from './pattern-room-orders-page.js';
import {canAccessPatternRoomOrders} from './pattern-room-access.js';
import {canUsePatternOrder} from '@dx-rework/contracts/pattern-orders';
import {validPatternReturnPath} from './pattern-order-query.js';
import {createWebUrls} from '../url-contract.js';
import {Button} from '@dx-rework/ui';
import {PatternDialog} from './pattern-dialog.js';
import {PatternOrderForm} from './pattern-order-form.js';
import {canLeaveInternalPage,navigateInternalPage} from './internal-navigation.js';
export function LegacyPatternWorkspace(){
 const [user,setUser]=useState<AuthorizedUser|null>(null),[error,setError]=useState('');
 const [creating,setCreating]=useState(false),[busy,setBusy]=useState(false);
 useEffect(()=>{let live=true;void verifySession().then(s=>{if(!live)return;if(s==='denied'||s.status!=='authorized')setError('请重新登录或联系管理员分配有效岗位');else setUser(s.user);});return()=>{live=false;};},[]);
 const urls=createWebUrls(import.meta.env.BASE_URL);
 const [returnTo,setReturnTo]=useState(()=>validPatternReturnPath(`/ui/digital-pattern-room${window.location.search}`)??'/ui/digital-pattern-room?section=legacy');
 const create=(capability:'pattern_room:orders:create'|'pattern_room:misc:create')=>Boolean(user&&(user.isRoot||canUsePatternOrder(user.businessRoles??[],user.capabilities,capability)));
 const closeCreate=async()=>{if(!busy&&await canLeaveInternalPage())setCreating(false);};
 const action=create('pattern_room:misc:create')?<a className="dx-button dx-button--primary" href={`${urls.pageUrl('ui/pattern-room/create')}?${new URLSearchParams({kind:'misc',returnTo})}`} onClick={event=>{if(event.button===0&&!event.metaKey&&!event.ctrlKey&&!event.shiftKey&&!event.altKey){event.preventDefault();setCreating(true);}}}>申请杂事</a>:undefined;
 return <section aria-label="杂事看板">{error&&<p role="alert">{error}</p>}{user?canAccessPatternRoomOrders(user)?<PatternRoomOrdersPage embedded miscOnly headerActions={action} onListPathChange={setReturnTo}/>:<p>当前岗位没有杂事看板读取权限。</p>:!error&&<p>正在读取原板房权限…</p>}
 {creating&&<div className="misc-create-drawer"><PatternDialog title="申请杂事" busy={busy} onClose={()=>void closeCreate()}><header><h2>申请杂事</h2><Button type="button" disabled={busy} onClick={()=>void closeCreate()}>关闭</Button></header><PatternOrderForm kind="misc" onBusyChange={setBusy} onCancel={()=>{setCreating(false);setBusy(false);}} onSaved={order=>{setCreating(false);setBusy(false);void navigateInternalPage(`${urls.pageUrl(`ui/pattern-room/orders/${order.orderId}`)}?${new URLSearchParams({returnTo})}`,{replace:true});}}/></PatternDialog></div>}
 </section>;
}
