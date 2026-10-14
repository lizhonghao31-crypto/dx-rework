import {useEffect,useState} from 'react';
import {Surface} from '@dx-rework/ui';
import {canUsePatternOrder} from '@dx-rework/contracts/pattern-orders';
import {Header} from './components.js';
import {verifySession} from './auth.js';
import {PatternOrderForm} from './pattern-order-form.js';
import {patternUrls} from './pattern-order-client.js';
import {patternReturnPath} from './pattern-order-query.js';
import {navigateInternalPage} from './internal-navigation.js';
import './pattern-room.css';
export function PatternOrderCreatePage(){
 const [allowed,setAllowed]=useState<boolean|null>(null),[error,setError]=useState('');
 const returnPath=patternReturnPath(window.location.search),oldPattern=new URLSearchParams(window.location.search).get('kind')==='pattern';
 useEffect(()=>{let live=true;void verifySession().then(session=>{
  if(!live)return;if(session==='denied'){setError('请重新登录');return;}
  const user=session.user,misc=user.isRoot===true||canUsePatternOrder(user.businessRoles??[],user.capabilities,'pattern_room:misc:create');
  setAllowed(misc);if(!misc)setError('当前账号没有新增杂事权限');
 }).catch(()=>{if(live)setError('读取创建权限失败，请刷新重试');});return()=>{live=false;};},[]);
 return <div className="pattern-orders pattern-create" data-dx-ui="governed"><Header title="新增杂事" badge="板房管理台" badgePlacement="subtitle" backHref={returnPath}/>
  {oldPattern?<Surface><p role="alert">已停止无来源独立打板新建；请从开发单发布生成打板执行单。</p></Surface>:error?<Surface><p role="alert">{error}</p></Surface>:allowed===null?<p role="status">正在读取…</p>:allowed&&<PatternOrderForm kind="misc" onCancel={()=>{void navigateInternalPage(patternUrls.pageUrl(returnPath));}} onSaved={order=>{void navigateInternalPage(`${patternUrls.pageUrl(`ui/pattern-room/orders/${order.orderId}`)}?${new URLSearchParams({returnTo:returnPath})}`,{replace:true});}}/>}
 </div>;
}
