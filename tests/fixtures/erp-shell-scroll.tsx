// Real Shell at 21 menu prop/URL contexts with module styles. Body markup is synthetic, not each page DOM.
import {createRoot} from 'react-dom/client';
import {Shell,Header} from '../../apps/web/src/components.js';
import {Button,Surface} from '@dx-rework/ui';
import '../../packages/ui/src/tokens.css';
import '../../packages/ui/src/components.css';
import '../../apps/web/src/styles.css';
import '../../apps/web/src/responsibility-determination.css';
import '../../apps/web/src/workflow-shell.css';
import '../../apps/web/src/dialog-visual-system.css';
import '../../apps/web/src/workflow-state-visual.css';
import '../../apps/web/src/ui-polish.css';
import '../../apps/web/src/my-todos.css';
import '../../apps/web/src/digital-cockpit.css';
import '../../apps/web/src/digital-analysis.css';
import '../../apps/web/src/digital-development-workspace.css';
import '../../apps/web/src/production-dashboard-page.css';
import '../../apps/web/src/production-reporting-page.css';
import '../../apps/web/src/order-board-page.css';
import '../../apps/web/src/pattern-room.css';
import '../../apps/web/src/pattern-governed.css';
import '../../apps/web/src/sourcing-workspace.css';
import '../../apps/web/src/sourcing-governed.css';
import '../../apps/web/src/cutting-page.css';
import '../../apps/web/src/rework-governed.css';
import '../../apps/web/src/reporting/reporting.css';
import '../../apps/web/src/wages/wage-period-list.css';
import '../../apps/web/src/supplier-center-page.css';
import '../../apps/web/src/sample-analysis.css';
import '../../apps/web/src/sample-operations.css';
export const hosts=[
 ['我的待办','/ui/my-tasks','我的待办','my-todos'],
 ['生产管理座舱','/ui/digital-cockpit','生产管理座舱','digital-journey-cockpit'],
 ['实时生产看板','/ui/production-dashboard?workspace=display','实时看板','production-dashboard'],
 ['生产数据填报','/ui/production-reporting','生产数据填报','production-reporting'],
 ['订单回货看板','/ui/orders','订单回货','order-board-page'],
 ['板房管理台','/ui/digital-pattern-room','digital-pattern','pattern-golden'],
 ['板房数据沙盘','/ui/digital-analysis','板房数据沙盘','digital-analysis analysis-workspace'],
 ['价格管控','/ui/pattern-room/prices','价格管控','pattern-prices'],
 ['待审批订单','/ui/sourcing/pending','待审批订单','sourcing-workspace'],
 ['历史订单','/ui/sourcing/history','历史订单','sourcing-workspace'],
 ['裁床实裁','/ui/cutting','cutting','cutting-page'],
 ['裁后工艺与发厂','/ui/digital-cockpit?stage=post_cutting&workspace=factory','生产管理座舱','factory-flow'],
 ['返工单看板','/ui/tasks','返工单看板','rework-query-content'],
 ['财务报表','/ui/reports','财务报表','reporting-page'],
 ['供应商目录','/ui/suppliers','供应商目录','supplier-center-workspace'],
 ['资料维护','/ui/suppliers/manage','资料维护','supplier-center-workspace'],
 ['在管样衣','/ui/samples','在管样衣','sample-workspace sample-ops'],
 ['待确认中心','/ui/samples/pending','待确认中心','sample-workspace sample-ops'],
 ['已处置样衣','/ui/samples/disposed','已处置样衣','sample-workspace sample-ops'],
 ['库存金额管理','/ui/samples/amounts','库存金额管理','sample-analysis-workspace'],
 ['工资管理','/ui/wages','工资管理','wage-management'],
] as const;
const params=new URLSearchParams(location.search),index=Number(params.get('fixtureHost')??0),host=hosts[index]??hosts[0],short=params.get('fixtureRole')==='worker',id='00000000-0000-4000-8000-000000000001';
const user={id,displayName:short?'TEST 师傅':'TEST 管理者',isRoot:!short,businessRoles:short?['pattern_room_worker']:['root_superuser'],capabilities:short?['todo:view','pattern_room:orders:view']:['todo:view','digital_production:view','access:admin','business:read_all']};
const requests:{path:string;method:string}[]=[];Object.assign(window,{shellScrollFixture:{hosts,index,requests}});
window.fetch=async(input,init)=>{const path=new URL(String(input),location.href).pathname,method=init?.method??'GET';requests.push({path,method});if(method==='POST'&&path.endsWith('/notifications/claim'))return Response.json({error:{message:'TEST notification service not enabled'}},{status:404});if(method!=='GET')throw Error('TEST Shell fixture permits reads only');if(path.endsWith('/auth/me'))return Response.json({status:'authorized',user});if(path.endsWith('/indicator'))return Response.json({pendingCount:short?0:7},{headers:{'x-dx-rework-actor-id':id}});return Response.json({error:{message:'TEST unmapped read'}},{status:404});};
const digital=[1,2,5,6,11].includes(index);
createRoot(document.getElementById('root')!).render(<Shell active={host[2]} appearance={digital?'digital':'standard'}><div className={host[3]} data-shell-host={host[0]}><Header title={host[0]} subtitle="TEST Shell 样式哨兵：代表性内容，不是整页业务验收"/><Surface><form data-testid="sentinel-form" onSubmit={e=>e.preventDefault()}><label>TEST 查询<input aria-label="TEST 查询" defaultValue="TEST-PO-001"/></label><Button type="submit">TEST 查询</Button></form><div data-testid="sentinel-table" style={{overflowX:'auto'}}><table><thead><tr><th>TEST 款号</th><th>TEST 状态</th><th>TEST 数量</th></tr></thead><tbody>{[1,2,3].map(i=><tr key={i}><td>TEST-PO-{i}</td><td>TEST 只读</td><td>{i*10}</td></tr>)}</tbody></table></div><Button data-testid="sentinel-action" type="button">TEST 原主动作</Button></Surface></div></Shell>);
