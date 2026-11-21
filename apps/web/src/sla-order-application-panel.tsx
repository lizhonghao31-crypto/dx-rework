import {ListPagination} from './list-pagination.js';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@dx-rework/ui';
import type {SlaApplicationCandidatesPage} from '@dx-rework/contracts/sla-settings-history';
type OrderChoice={productionOrderId:string;designStyleNo:string;customerCode:string;selectable?:boolean;reason?:string|null;adoptedVersion?:number|null;pos?:string[]};
import { DIGITAL_SLA_PARAMETERS } from '@dx-rework/contracts/digital-sla';
import { digitalRequest, DigitalRequestError } from './digital-production-api.js';
import { createClientRequestId } from './client-request-id.js';
type NodeTime = {
    forecast: {
        at: string | null;
        reasons: string[];
    };
    deadline: {
        at: string | null;
        exclusive?: boolean;
    };
    status: string;
    actualStart: string | null;
};
type Preview = {
    orderId: string;
    token: string;
    configurationVersion: number;
    changes: {
        nodeId: string;
        label: string;
        beforeMinutes: number | null;
        afterMinutes: number | null;
        beforeWarningPercent: number;
        afterWarningPercent: number;
        beforeDays: number | null;
        afterDays: number | null;
        before: NodeTime;
        after: NodeTime;
    }[];
    skipped: string[];
    adoptedParameters?:{key:string;label:string;source:'global'|'customer'|'order';version:number}[];
    retainedCompletedNodes?:string[];
    notificationChanges?:{key:string;label:string;beforeEnabled:boolean;afterEnabled:boolean}[];
};
type Row = {
    preview?: Preview;
    key?: string;
    state: 'previewed' | 'failed' | 'unknown' | 'applied';
    message?: string;
    body?: unknown;
};
const date = (at: string | null, exclusive = false) => at ? exclusive ? `${new Date(Date.parse(at) - 1).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' })} 当天结束` : new Date(at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '无可靠预计';
export function SlaOrderApplicationPanel({ expanded=false,managedCandidates=false,version, parameterKeys, disabled, onPendingChange }: {
    expanded?:boolean;managedCandidates?:boolean;
    version: number;
    parameterKeys: string[];
    disabled: boolean;
    onPendingChange(value: boolean): void;
}) {
    const [orders, setOrders] = useState<OrderChoice[]>([]), [query, setQuery] = useState(''), [page, setPage] = useState(1), [selection, setSelection] = useState<string[]>([]), [reason, setReason] = useState(''), [rows, setRows] = useState<Record<string, Row>>({}), [busy, setBusy] = useState(false), [error, setError] = useState('');
    const [total,setTotal]=useState<number|null>(null),[labels,setLabels]=useState<Record<string,OrderChoice>>({});
    const running = useRef(false), live = useRef(true);
    const keyString = JSON.stringify([...parameterKeys].sort()), unknown = Object.values(rows).some(r => r.state === 'unknown');
    useEffect(() => { if (!unknown)
        setRows({}); }, [version, keyString, reason]);
    useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
    useEffect(() => { onPendingChange(busy || unknown); return () => onPendingChange(false); }, [busy, unknown, onPendingChange]);
    useEffect(() => { const listener = (e: BeforeUnloadEvent) => { if (unknown || busy) {
        e.preventDefault();
        e.returnValue = '';
    } }; window.addEventListener('beforeunload', listener); return () => window.removeEventListener('beforeunload', listener); }, [unknown, busy]);
    const search = async (nextPage = 1) => { if (running.current)
        return; running.current = true; setBusy(true); setError(''); try {
        const result = managedCandidates?await digitalRequest<SlaApplicationCandidatesPage>(`sla-settings/orders/candidates?page=${nextPage}&search=${encodeURIComponent(query)}`):await digitalRequest<{items:OrderChoice[];total:number}>(`orders?page=${nextPage}&search=${encodeURIComponent(query)}`);
        const items:OrderChoice[]=managedCandidates?(result as SlaApplicationCandidatesPage).items.map(row=>({productionOrderId:row.orderId,...row})):result.items as OrderChoice[];
        if (live.current) {
            setOrders(items);setLabels(prior=>({...prior,...Object.fromEntries(items.map(row=>[row.productionOrderId,row]))}));
            setPage(nextPage);setTotal(result.total);
        }
    }
    catch (e) {
        if (live.current)
            setError(e instanceof Error ? e.message : '读取失败');
    }
    finally {
        running.current = false;
        if (live.current)
            setBusy(false);
    } };
    const run = async (apply: boolean) => {
        if (running.current)
            return;
        running.current = true;
        setBusy(true);
        setError('');
        try {
            for (const orderId of selection) {
                const prior = rows[orderId];
                if (prior?.state === 'applied')
                    continue;
                const body = { orderId, configurationVersion: version, parameterKeys, reason: reason.trim() };
                if (apply && (!prior?.preview || !['previewed', 'unknown'].includes(prior.state)))
                    continue;
                try {
                    if (apply) {
                        const exact = prior?.body ?? { ...body, previewToken: prior!.preview!.token }, key = prior?.key ?? createClientRequestId();
                        setRows(r => ({ ...r, [orderId]: { ...prior!, body: exact, key } }));
                        try {
                            const result = await digitalRequest<{
                                orderId: string;
                                applicationId: string;
                            }>('sla-settings/orders/apply', 'POST', exact, key);
                            if (result.orderId !== orderId || !result.applicationId)
                                throw new DigitalRequestError('提交结果不完整', null);
                            setRows(r => ({ ...r, [orderId]: { ...r[orderId]!, state: 'applied', message: '已应用，原起点及历史保留' } }));
                        }
                        catch (e) {
                            setRows(r => ({ ...r, [orderId]: { ...r[orderId]!, state: e instanceof DigitalRequestError && e.resultUnknown ? 'unknown' : 'failed', message: e instanceof Error ? e.message : '应用失败' } }));
                        }
                    }
                    else {
                        const preview = await digitalRequest<Preview>('sla-settings/orders/preview', 'POST', body);
                        if (!preview.token || preview.orderId !== orderId || !Array.isArray(preview.changes))
                            throw new Error('预览返回不完整');
                        setRows(r => ({ ...r, [orderId]: { preview, state: 'previewed' } }));
                    }
                }
                catch (e) {
                    setRows(r => ({ ...r, [orderId]: { state: 'failed', message: e instanceof Error ? e.message : '本单未能预览' } }));
                }
            }
        }
        finally {
            running.current = false;
            if (live.current)
                setBusy(false);
        }
    };
    const locked = disabled || busy || unknown;
    return <details open={expanded||undefined} className="sla-settings-help"><summary>指定在途订单应用现行标准</summary>
  <p>仅应用已发布的 v{version}。先勾选调整项，再选择订单；已有订单或客户特例保留，已完成节点不改。</p>
  {disabled && <p>请先处理上方未发布草稿，再应用现行标准。</p>}
  <p>已选参数：{parameterKeys.map(k => DIGITAL_SLA_PARAMETERS.find(p => p.key === k)?.label).join('、') || '尚未选择'}</p>
  {error && <p role="alert">{error}</p>}
  <div className="sla-standard-toolbar"><label>查找订单<input value={query} disabled={locked} onChange={e => setQuery(e.target.value)}/></label><Button variant="secondary" disabled={locked} onClick={() => void search()}>查找</Button></div>
  <ul className="sla-standard-rows">{orders.map(order => <li key={order.productionOrderId}><label><input type="checkbox" disabled={locked || order.selectable===false || selection.length >= 20 && !selection.includes(order.productionOrderId) || rows[order.productionOrderId]?.state === 'applied'} checked={selection.includes(order.productionOrderId)} onChange={e => setSelection(s => e.target.checked ? [...s, order.productionOrderId] : s.filter(id => id !== order.productionOrderId))}/>{order.designStyleNo} · {order.customerCode}{order.pos?.length?` · PO ${order.pos.join('、')}`:''}{order.adoptedVersion?` · 原统一标准 v${order.adoptedVersion}`:''}{managedCandidates&&<small>{order.reason??'待预览核实可调整节点'}</small>}</label></li>)}</ul>
  {total!==null&&<ListPagination page={page} totalPages={total===null?null:Math.max(1,Math.ceil(total/15))} total={total} busy={locked} onPageChange={target=>void search(target)} ariaLabel="应用标准订单分页"/>}
  <label className="sla-change-reason">本次应用原因<input value={reason} disabled={locked} maxLength={1000} onChange={e => setReason(e.target.value)}/></label>
  <Button disabled={locked || !selection.length || !parameterKeys.length || !reason.trim()} onClick={() => void run(false)}>预览选定订单（{selection.length}）</Button>
  <p aria-live="polite">已选 {selection.length} 单；预览可调整 {Object.values(rows).filter(row=>row.state==='previewed').length} 单</p>
  <div aria-live="polite">{selection.map(id => rows[id] && <details key={id} className="sla-publish-preview"><summary>{labels[id]?.designStyleNo??'已选订单'} · {({ previewed: '可应用', failed: '未应用', unknown: '结果待确认', applied: '已应用' })[rows[id]!.state]}</summary>{rows[id]!.message && <p>{rows[id]!.message}</p>}{Boolean(rows[id]!.preview?.adoptedParameters?.length)&&<p>参数原采用：{rows[id]!.preview!.adoptedParameters!.map(value=>`${value.label} · ${{global:'统一标准',customer:'客户特例',order:'订单特例'}[value.source]} v${value.version}`).join('；')}。本次现行统一标准 v{version}，原特例保留。</p>}{Boolean(rows[id]!.preview?.retainedCompletedNodes?.length)&&<p>已完成节点保留：{rows[id]!.preview!.retainedCompletedNodes!.join('、')}</p>}{Boolean(rows[id]!.preview?.notificationChanges?.length)&&<div className="sla-application-reminder-changes" aria-label="提醒启停变化">{rows[id]!.preview!.notificationChanges!.map(change=><p key={change.key}><strong>{change.label}</strong>：{change.beforeEnabled?'开启':'关闭'} → {change.afterEnabled?'开启':'关闭'}</p>)}<small>启停不取消任务或改写历史。</small></div>}{rows[id]!.preview?.changes.map(c => <div key={c.nodeId}><strong>{c.label}</strong>{c.beforeWarningPercent !== c.afterWarningPercent && <p>临期比例：{c.beforeWarningPercent}% → {c.afterWarningPercent}%</p>}{c.beforeDays !== c.afterDays && <p>完成提前量：{c.beforeDays} 天 → {c.afterDays} 天</p>}{c.beforeMinutes !== c.afterMinutes && <p>时长：{c.beforeMinutes === null ? '无独立时限' : `${c.beforeMinutes / 60} 小时`} → {c.afterMinutes === null ? '无独立时限' : `${c.afterMinutes / 60} 小时`}</p>}<p>预计完成：{date(c.before.forecast.at)} → {date(c.after.forecast.at)}</p>{c.before.deadline.at !== c.after.deadline.at && <p>截止：{date(c.before.deadline.at, c.before.deadline.exclusive)} → {date(c.after.deadline.at, c.after.deadline.exclusive)}</p>}{c.after.forecast.reasons.length > 0 && <p>{c.after.forecast.reasons.join('；')}</p>}</div>)}{!!rows[id]!.preview?.skipped.length && <p>已有合法订单/客户特例保持不变。</p>}</details>)}</div>
  {Object.values(rows).some(r => r.state === 'previewed' || r.state === 'unknown') && <Button disabled={busy || disabled} onClick={() => void run(true)}>{unknown ? '用原命令确认未明结果' : '确认逐单应用'}</Button>}
  {Object.values(rows).some(r => r.state === 'applied') && <p role="status">已应用 {Object.values(rows).filter(r => r.state === 'applied').length} 单；未应用或未确认 {selection.filter(id => rows[id]?.state !== 'applied').length} 单。</p>}
 </details>;
}
