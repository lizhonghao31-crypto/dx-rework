import {useEffect,useState} from 'react';
import {verifySession,type AuthorizedUser} from './auth.js';
import {PatternRoomOrdersPage} from './pattern-room-orders-page.js';
import {canAccessPatternRoomOrders} from './pattern-room-access.js';
import {canUsePatternOrder} from '@dx-rework/contracts/pattern-orders';
import {validPatternReturnPath} from './pattern-order-query.js';
import {createWebUrls} from '../url-contract.js';
export function LegacyPatternWorkspace(){
 const [user,setUser]=useState<AuthorizedUser|null>(null),[error,setError]=useState('');
 useEffect(()=>{let live=true;void verifySession().then(s=>{if(!live)return;if(s==='denied'||s.status!=='authorized')setError('请重新登录或联系管理员分配有效岗位');else setUser(s.user);});return()=>{live=false;};},[]);
 const urls=createWebUrls(import.meta.env.BASE_URL);
 const [returnTo,setReturnTo]=useState(()=>validPatternReturnPath(`/ui/digital-pattern-room${window.location.search}`)??'/ui/digital-pattern-room?section=legacy');
 const create=(capability:'pattern_room:orders:create'|'pattern_room:misc:create')=>Boolean(user&&(user.isRoot||canUsePatternOrder(user.businessRoles??[],user.capabilities,capability)));
 return <section aria-label="杂事看板"><h2>杂事看板</h2>{error&&<p role="alert">{error}</p>}{user?<><div className="pattern-actions">{create('pattern_room:misc:create')&&<a className="dx-button" href={`${urls.pageUrl('ui/pattern-room/create')}?${new URLSearchParams({kind:'misc',returnTo})}`}>申请杂事</a>}</div>{canAccessPatternRoomOrders(user)?<PatternRoomOrdersPage embedded miscOnly onListPathChange={setReturnTo}/>:<p>当前岗位没有杂事看板读取权限。</p>}</>:!error&&<p>正在读取原板房权限…</p>}</section>;
}
