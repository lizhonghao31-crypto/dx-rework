import { App } from '../../apps/web/src/App.js';
import '../../apps/web/src/workflow-shell.css';
import '../../apps/web/src/dialog-visual-system.css';
import '../../apps/web/src/workflow-state-visual.css';
import '../../apps/web/src/ui-polish.css';
import { createRoot } from 'react-dom/client';
import { CockpitProductionSettings } from '../../apps/web/src/cockpit-production-settings.js';
import { digitalSlaDefaults } from '@dx-rework/contracts/digital-sla';
import '../../packages/ui/src/tokens.css';
import '../../packages/ui/src/components.css';
import '../../apps/web/src/styles.css';
let values = digitalSlaDefaults(), version = 1;
const writes: unknown[] = [];
const attempts = new Map<string, number>();
Reflect.set(window, 'slaWrites', writes);
const reads: string[] = [];
Reflect.set(window, 'slaReads', reads);
window.fetch = async (path, init) => {
    const url = String(path);
    reads.push(url);
    if (url.endsWith('/auth/me'))
        return Response.json({ status: 'authorized', user: { id: 'TEST-owner', displayName: 'TEST 供应链总监', businessRoles: ['production_management'], capabilities: ['digital_production:view', 'todo:view'] } });
    if (url.endsWith('/todos/mine/indicator'))
        return Response.json({ pendingCount: 0, unreadCount: 0 }, { headers: { 'x-dx-rework-actor-id': 'TEST-owner' } });
    if (url.endsWith('/access/options'))
        return Response.json({ manage: !location.search.includes('readonly'), customers: false });
    if (url.includes('/orders?page='))
        return Response.json({ items: ['a', 'b'].map((id, i) => ({ productionOrderId: id, designStyleNo: `TEST-订单${i + 1}`, customerCode: 'TEST-PD' })) });
    if (url.includes('/sla-settings?version='))
        return Response.json({ version: 1, values: digitalSlaDefaults(), scope: 'new_orders', history: [] });
    if (url.endsWith('/sla-settings'))
        return Response.json({ version, values, scope: 'new_orders', history: [{ version: 1, reason: '初始标准' }] });
    if (!init?.body)
        return Response.json({ message: 'TEST unsupported read' }, { status: 404 });
    const body = JSON.parse(String(init?.body));
    writes.push({ url, body, key: new Headers(init?.headers).get('idempotency-key') });
    if (url.endsWith('/orders/preview'))
        return Response.json({ orderId: body.orderId, token: 'TEST-preview', configurationVersion: version, skipped: [], changes: [{ nodeId: 'warehouse_preshrink', label: '必做预缩', beforeMinutes: 2160, afterMinutes: 4320, before: { forecast: { at: null, reasons: ['未填原到布日期'] }, deadline: { at: null }, status: 'unknown', actualStart: null }, after: { forecast: { at: null, reasons: ['未填原到布日期'] }, deadline: { at: null }, status: 'unknown', actualStart: null } }] });
    if (url.endsWith('/orders/apply')) {
        const count = (attempts.get(body.orderId) ?? 0) + 1;
        attempts.set(body.orderId, count);
        if (body.orderId === 'b' && location.search.includes('partial'))
            return Response.json({ message: 'TEST 本单资料已改变，重新预览' }, { status: 409 });
        if (body.orderId === 'b' && location.search.includes('unknown') && count === 1)
            throw new TypeError('TEST response lost after commit');
        return Response.json({ orderId: body.orderId, applicationId: `TEST-${body.orderId}` });
    }
    if (url.endsWith('/preview')) {
        if (location.search.includes('conflict'))
            return Response.json({ code: 'DIGITAL_TASK_CONFLICT', message: '现行标准已改变，请重新预览' }, { status: 409 });
        return Response.json({ token: 'a'.repeat(64), version, scope: 'new_orders', existingOrdersChanged: 0, changes: Object.entries(body.values).filter(([key, v]) => JSON.stringify(values[key]) !== JSON.stringify(v)).map(([key, v]) => ({ key, label: key === 'warning_ratio' ? '节点临期比例' : '节点工时', before: values[key], after: v })) });
    }
    if (url.endsWith('/publish')) {
        values = body.values;
        version++;
        return Response.json({ version, scope: 'new_orders', existingOrdersChanged: 0 });
    }
    return Response.json({ message: 'unexpected' }, { status: 404 });
};
createRoot(document.getElementById('root')!).render(location.pathname === '/ui/digital-cockpit' ? <App /> : <main className="dx-production-ui"><CockpitProductionSettings /></main>);
