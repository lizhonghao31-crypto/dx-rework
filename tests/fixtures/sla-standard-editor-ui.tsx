import { App } from '../../apps/web/src/App.js';
import '../../apps/web/src/workflow-shell.css';
import '../../apps/web/src/dialog-visual-system.css';
import '../../apps/web/src/workflow-state-visual.css';
import '../../apps/web/src/ui-polish.css';
import { createRoot } from 'react-dom/client';
import { CockpitProductionSettings } from '../../apps/web/src/cockpit-production-settings.js';
import { digitalSlaDefaults } from '@dx-rework/contracts/digital-sla';
import {DEVELOPMENT_CYCLE_DEFAULTS} from '@dx-rework/contracts/digital-development-technical';
import {SlaCalculationPreviewSchema,type SlaCalculationContext} from '@dx-rework/contracts/sla-calculation';
import {buildSlaCalculationRoute} from '@dx-rework/domain/sla-calculation-routes';
import {calculateSlaPreview,calculationDraftGraph} from '@dx-rework/domain/sla-calculation';
import '../../packages/ui/src/tokens.css';
import '../../packages/ui/src/components.css';
import '../../apps/web/src/styles.css';
let values = digitalSlaDefaults(), version = 1;
let development={...DEVELOPMENT_CYCLE_DEFAULTS},developmentVersion=1,contextRevision=0,conflicted=false,refreshFailures=0;
const published=new Map<string,{body:string;response:unknown}>(),lost=new Set<string>();
const digest=async(value:unknown)=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value))))].map(byte=>byte.toString(16).padStart(2,'0')).join('');
Reflect.set(window,'slaHarness',{bumpContext:()=>contextRevision++,state:()=>({version,developmentVersion,values:structuredClone(values),development:{...development}})});
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
        return Response.json({ manage: !/readonly|pmc/.test(location.search), customers: false,...(location.search.includes('pmc')?{roles:['pmc']}:{} )});
    if(url.endsWith('/development-technical-settings'))return Response.json({version:developmentVersion,values:development,scope:'new_sources',history:[{version:1,reason:'TEST initial independent standard'}]});
    if(url.endsWith('/series-profiles')&&(!init?.method||init.method==='GET'))return Response.json({profiles:[{customerCode:null,version:1,monthOffset:location.search.includes('series-nondefault')?-3:-2,shippingDay:location.search.includes('series-nondefault')?20:null,reason:'TEST transport fixture'}]});
    if (url.includes('/orders?page='))
        return Response.json({ items: ['a', 'b'].map((id, i) => ({ productionOrderId: id, designStyleNo: `TEST-订单${i + 1}`, customerCode: 'TEST-PD' })) });
    if (url.includes('/sla-settings?version='))
        return Response.json({ version: 1, values: digitalSlaDefaults(), scope: 'new_orders', history: [] });
    if(url.endsWith('/sla-settings')&&refreshFailures){refreshFailures--;return Response.json({message:'TEST published but refresh lost'}, {status:503});}
    if (url.endsWith('/sla-settings'))
        return Response.json({ version, values, scope: 'new_orders', history: [{ version: 1, reason: '初始标准' }] });
    if (!init?.body)
        return Response.json({ message: 'TEST unsupported read' }, { status: 404 });
    const body = JSON.parse(String(init?.body));
    if(url.endsWith('/sla-settings/calculation-preview')){
      const input=SlaCalculationPreviewSchema.parse(body);if(input.selection.mode!=='example')return Response.json({message:'TEST transport fixture has no native instances'}, {status:404});
      if(input.unified&&input.unified.expectedVersion!==version||input.development&&input.development.expectedVersion!==developmentVersion)return Response.json({message:'TEST policy version changed'}, {status:409});
      const selection=input.selection,context:SlaCalculationContext={selection,identity:{kind:'example',id:null,sourceId:null,orderId:null,round:null,label:'TEST controlled transport fixture'},unified:{version,values:structuredClone(values)},development:{version:developmentVersion,values:{...development}},graph:buildSlaCalculationRoute({range:selection.range,conditions:selection.conditions,anchors:selection.references,values,unifiedSource:`TEST unified v${version}`,development,developmentSource:`TEST independent v${developmentVersion}`}),bindings:{fixture:'controlled TEST transport, not native authorization',contextRevision},limitations:['TEST transport fixture: actual shared contracts/routes/calculator; native API/PG proof is separate.']};
      const contextDigest=await digest(context),current=calculateSlaPreview(context.graph),draftValues={unified:input.unified?.values??values,development:input.development?.values??development},draft=calculateSlaPreview(calculationDraftGraph(context.graph,{unified:values,development},draftValues));
      return Response.json({context,contextDigest,contextChanged:input.checkContextDigest!==undefined&&input.checkContextDigest!==contextDigest,current,draft,differences:{overallMs:current.overall.spanMs!==null&&draft.overall.spanMs!==null?draft.overall.spanMs-current.overall.spanMs:null,stages:[],nodes:[]},calculationReceipt:{purpose:'read_only_calculation',contextDigest,valuesDigest:await digest(draftValues),resultDigest:await digest(draft),calculatorVersion:draft.calculatorVersion,calendarVersion:draft.calendarVersion,status:draft.overall.status}});
    }
    writes.push({ url, body, key: new Headers(init?.headers).get('idempotency-key') });
    if(url.endsWith('/development-technical-settings/preview'))return Response.json({token:'TEST independent preview',version:developmentVersion,scope:'new_sources',existingSourcesChanged:0,changes:Object.entries(body.values).filter(([key,value])=>development[key as keyof typeof development]!==value).map(([key,after])=>({key,before:development[key as keyof typeof development],after}))});
    if(url.endsWith('/development-technical-settings/publish')){if(location.search.includes('dev-fail'))return Response.json({message:'TEST independent outcome unavailable'}, {status:503});development=body.values;developmentVersion++;return Response.json({version:developmentVersion,scope:'new_sources',existingSourcesChanged:0});}
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
        if (location.search.includes('conflict')&&!conflicted){conflicted=true;version++;values={...values,warning_ratio:{kind:'ratio',percent:75}};
            return Response.json({ code: 'DIGITAL_TASK_CONFLICT', message: '现行标准已改变，请重新预览' }, { status: 409 });
        }
        return Response.json({ token: 'a'.repeat(64), version, scope: 'new_orders', existingOrdersChanged: 0, changes: Object.entries(body.values).filter(([key, v]) => JSON.stringify(values[key]) !== JSON.stringify(v)).map(([key, v]) => ({ key, label: key === 'warning_ratio' ? '节点临期比例' : '节点工时', before: values[key], after: v })) });
    }
    if (url.endsWith('/publish')) {
        const key=new Headers(init?.headers).get('idempotency-key')??'',prior=published.get(key);if(prior){if(prior.body!==JSON.stringify(body))return Response.json({message:'TEST original key reused for other values'}, {status:409});return Response.json(prior.response);}
        values = body.values;
        version++;
        const response={version,scope:'new_orders',existingOrdersChanged:0};published.set(key,{body:JSON.stringify(body),response});
        if(location.search.includes('refresh-fail'))refreshFailures=1;
        if(location.search.includes('publish-unknown')&&!lost.has(key)){lost.add(key);throw new TypeError('TEST response lost after native-contract-shaped commit');}
        return Response.json(response);
    }
    return Response.json({ message: 'unexpected' }, { status: 404 });
};
createRoot(document.getElementById('root')!).render(location.pathname === '/ui/digital-cockpit' ? <App /> : <main className="dx-production-ui"><CockpitProductionSettings /></main>);
