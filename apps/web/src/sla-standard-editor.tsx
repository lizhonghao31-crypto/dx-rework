import { slaParameterHints } from './sla-parameter-hints.js';
import { confirmInApp } from './system-dialog.js';
import { SlaOrderApplicationPanel } from './sla-order-application-panel.js';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@dx-rework/ui';
import { JOURNEY_STAGES } from '@dx-rework/contracts/digital-production-journey';
import { DIGITAL_SLA_PARAMETERS, digitalSlaDefaults, validateDigitalSlaValues, type DigitalSlaValue, type DigitalSlaValues } from '@dx-rework/contracts/digital-sla';
import { digitalRequest, DigitalRequestError } from './digital-production-api.js';
import { createClientRequestId } from './client-request-id.js';
type Standard = {
    version: number;
    values: DigitalSlaValues;
    scope: 'new_orders';
    history: {
        version: number;
        reason: string;
    }[];
};
type Preview = {
    token: string;
    version: number;
    scope: 'new_orders';
    existingOrdersChanged: number;
    changes: {
        key: string;
        label: string;
        before: DigitalSlaValue;
        after: DigitalSlaValue;
    }[];
};
const batchGroup = (key: string, value: DigitalSlaValue) => ['development_pre_wash_check', 'development_tail_check'].includes(key) ? 'independent_inspection' : value.kind;
const editable = (v: DigitalSlaValue) => !['unlimited', 'order_date'].includes(v.kind);
export const slaValueLabel = (v: DigitalSlaValue) => 'minutes' in v ? `${v.minutes / 60} 小时${v.kind === 'included' ? '（内含）' : v.kind === 'estimate' ? '（仅预计）' : ''}` : 'days' in v ? `提前 ${v.days} 天` : 'percent' in v ? `${v.percent}%` : v.kind === 'order_date' ? '按订单日期' : '无独立时限';
const scalar = (v: DigitalSlaValue) => 'minutes' in v ? v.minutes : 'days' in v ? v.days : 'percent' in v ? v.percent : 0;
const withScalar = (v: DigitalSlaValue, n: number): DigitalSlaValue => 'minutes' in v ? { ...v, minutes: n } : 'days' in v ? { ...v, days: n } : 'percent' in v ? { ...v, percent: n } : v;
const defaultUnit = (v: DigitalSlaValue) => 'minutes' in v ? (v.kind === 'included' || v.kind === 'buffer' ? 'minutes' : 'hours') : 'days' in v ? 'days' : 'percent';
const factor = (unit: string) => unit === 'days-duration' ? 1440 : unit === 'hours' ? 60 : 1;
function ValueInput({ value, label, onChange, disabled }: {
    value: DigitalSlaValue;
    label: string;
    onChange(v: DigitalSlaValue): void;
    disabled: boolean;
}) {
    const [unit, setUnit] = useState(defaultUnit(value));
    if (!editable(value))
        return <span>{slaValueLabel(value)}</span>;
    return <span className="sla-value-input"><input aria-label={`${label}数值`} disabled={disabled} type="number" min={value.kind === 'offset' || value.kind === 'buffer' ? 0 : 0.00001} step="any" value={scalar(value) / factor(unit)} onChange={e => onChange(withScalar(value, Number(e.target.value) * factor(unit)))}/>{'minutes' in value ? <select aria-label={`${label}单位`} value={unit} disabled={disabled} onChange={e => setUnit(e.target.value)}><option value="minutes">分钟</option><option value="hours">小时</option><option value="days-duration">天（24小时）</option></select> : <span>{value.kind === 'ratio' ? '%' : '天'}</span>}</span>;
}
export function SlaStandardEditor({readOnly=false}:{readOnly?:boolean}={}) {
    const [current, setCurrent] = useState<Standard | null>(null), [values, setValues] = useState<DigitalSlaValues>({}), [stage, setStage] = useState(0), [query, setQuery] = useState(''), [selected, setSelected] = useState<string[]>([]), [reason, setReason] = useState(''), [preview, setPreview] = useState<Preview | null>(null), [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false), [orderPending, setOrderPending] = useState(false), [historyVersion, setHistoryVersion] = useState('');
    const [viewVersion,setViewVersion]=useState<number|null>(null);
    const pending = useRef<{
        body: unknown;
        key: string;
    } | null>(null), active = useRef(false), live = useRef(true), loadSequence = useRef(0);
    const load = async () => { const sequence = ++loadSequence.current; const row = await digitalRequest<Standard>('sla-settings'); if (!Number.isInteger(row.version) || row.scope !== 'new_orders')
        throw new Error('标准返回不完整，请刷新'); validateDigitalSlaValues(row.values); if (live.current && sequence === loadSequence.current) {
        setCurrent(row);
        setViewVersion(row.version);
        setValues(row.values);
        setPreview(null);
        setSelected([]);
    } };
    useEffect(() => { live.current = true; void load().catch(e => { if (live.current)
        setError(e.message); }); return () => { live.current = false; }; }, []);
    const dirty = !readOnly && !!current && JSON.stringify(current.values) !== JSON.stringify(values);
    useEffect(() => { const guard = (e: BeforeUnloadEvent) => { if (dirty || uncertain) {
        e.preventDefault();
        e.returnValue = '';
    } }; window.addEventListener('beforeunload', guard); return () => window.removeEventListener('beforeunload', guard); }, [dirty, uncertain]);
    const change = (key: string, value: DigitalSlaValue) => { setValues(v => ({ ...v, [key]: value })); setPreview(null); setNotice(''); };
    const execute = async (publish: boolean) => {
        if (readOnly || active.current || !current)
            return;
        active.current = true;
        setBusy(true);
        setError('');
        try {
            validateDigitalSlaValues(values);
            const draft = { expectedVersion: current.version, values, reason: reason.trim() };
            if (publish) {
                if (!pending.current) {
                    if (!preview)
                        throw new Error('请先预览');
                    pending.current = { body: { ...draft, previewToken: preview.token }, key: createClientRequestId() };
                }
                const result = await digitalRequest<{
                    version: number;
                    scope: string;
                    existingOrdersChanged: number;
                }>('sla-settings/publish', 'POST', pending.current.body, pending.current.key);
                if (!Number.isInteger(result.version) || result.scope !== 'new_orders' || result.existingOrdersChanged !== 0)
                    throw new DigitalRequestError('提交结果不完整，请使用原命令重试', null);
                pending.current = null;
                setUncertain(false);
                setPreview(null);
                setNotice(`已发布 v${result.version}，仅新订单采用；在途订单未改变。`);
                setReason('');
                try {
                    await load();
                }
                catch {
                    setError('已发布，读取新标准失败。请刷新页面，不要重新提交。');
                }
            }
            else {
                const result = await digitalRequest<Preview>('sla-settings/preview', 'POST', draft);
                if (!result.token || result.scope !== 'new_orders' || !Array.isArray(result.changes))
                    throw new Error('预览返回不完整');
                setPreview(result);
            }
        }
        catch (e) {
            setError(e instanceof Error ? e.message : '操作失败');
            if (publish && e instanceof DigitalRequestError && e.resultUnknown)
                setUncertain(true);
            else if (publish) {
                pending.current = null;
                setUncertain(false);
                setPreview(null);
            }
        }
        finally {
            active.current = false;
            if (live.current)
                setBusy(false);
        }
    };
    if (!current)
        return <section className="cockpit-settings-node-section">{error ? <p role="alert">{error}</p> : <p>正在读取时效标准…</p>}</section>;
    const rows = DIGITAL_SLA_PARAMETERS.filter(p => query ? p.label.includes(query) : stage === 0 ? p.stage === 0 || ['ship_sample_advance', 'order_shipping_reminder'].includes(p.key) : p.stage === stage), chosen = DIGITAL_SLA_PARAMETERS.filter(p => selected.includes(p.key)), first = chosen[0], batchValid = !!first && chosen.every(p => batchGroup(p.key, values[p.key]!) === batchGroup(first.key, values[first.key]!));
    const disabled = busy || uncertain || orderPending;
    return <section className="cockpit-settings-node-section" aria-label="统一时效标准">
  <div className="cockpit-settings-section-title"><h2>时效标准</h2><span>v{readOnly?viewVersion??current.version:current.version} · 默认只用于新订单</span></div>
  {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
  <div className="sla-standard-toolbar"><label>查找节点 <input type="search" value={query} placeholder="例如：印花、装箱" onChange={e => setQuery(e.target.value)}/></label><Button variant="secondary" disabled={disabled} onClick={() => { void (async () => { if (active.current)
        return; if (dirty && !await confirmInApp('放弃未发布草稿，读取现行标准？', { title: '读取现行标准', confirmLabel: '放弃草稿并读取' }))
        return; active.current = true; setBusy(true); try {
        await load();
    }
    finally {
        active.current = false;
        if (live.current)
            setBusy(false);
    } })().catch(e => setError(e.message)); }}>读取现行标准</Button></div>
  <nav className="sla-stage-tabs" aria-label="时效阶段"><Button variant="secondary" aria-pressed={stage === 0} onClick={() => { setStage(0); setQuery(''); }}>常用</Button>{JOURNEY_STAGES.map((p, i) => <Button key={p.key} variant="secondary" aria-pressed={stage === i + 1} onClick={() => { setStage(i + 1); setQuery(''); }}>{p.label}</Button>)}</nav>
  {!readOnly && chosen.length > 0 && <div className="sla-standard-toolbar"><span>已选 {chosen.length} 项</span>{chosen.length > 1 && <Button variant="secondary" disabled={disabled || !batchValid} onClick={() => { if (!first)
        return; setValues(v => ({ ...v, ...Object.fromEntries(chosen.map(p => [p.key, { ...v[first.key]! }])) })); setPreview(null); }}>统一为“{first?.label}”的数值</Button>}<Button variant="secondary" onClick={() => setSelected([])}>清空选择</Button>{!batchValid && <small>只可统一同一种时效，不混算提前量、工时与物流预计。</small>}</div>}
  <ul className="sla-standard-rows">{rows.map(p => <li key={p.key}><label className="sla-node-name">{!readOnly&&<input type="checkbox" disabled={disabled || !editable(values[p.key]!)} checked={selected.includes(p.key)} onChange={e => setSelected(s => e.target.checked ? [...s, p.key] : s.filter(k => k !== p.key))}/>}<span>{p.label}{p.defaultValue.kind === 'included' && <small>已含在所属工时内</small>}{p.defaultValue.kind === 'estimate' && <small>仅预计，不是收货期限</small>}</span></label>{readOnly?<span>{slaValueLabel(values[p.key]!)}</span>:<ValueInput value={values[p.key]!} label={p.label} onChange={v => change(p.key, v)} disabled={disabled}/>}</li>)}</ul>
  {!rows.length && <p>没有匹配节点。</p>}
  <details className="sla-settings-help"><summary>计算规则与历史</summary><p>连续自然时间，包含正常等待。内含项目不重复相加；阶段时长由适用路径计算，串行相加、并行取最长。这里不能关闭业务条件。日期目标按北京时间当天结束；具体时刻按原精度判断。</p>{!readOnly&&<p>选择跨阶段的同类节点，可统一使用其中一项数值；提前量、临期比例、预计物流不混算。未知实际时间保持未知。</p>}<details><summary>当前节点起止口径</summary><ul>{rows.map(p => <li key={p.key}><strong>{p.label}</strong>：{slaParameterHints[p.key]}</li>)}</ul></details>{!readOnly&&<><Button variant="secondary" disabled={disabled} onClick={() => { setValues(digitalSlaDefaults()); setPreview(null); }}>把初始标准复制到草稿</Button><p>复制不会直接发布，也不改历史实际或已有订单。</p></>}<label>历史标准 <select aria-label="选择历史标准" disabled={disabled} value={historyVersion} onChange={e => setHistoryVersion(e.target.value)}><option value="">选择已发布版本</option>{current.history.map(h => <option key={h.version} value={h.version}>v{h.version} · {h.reason}</option>)}</select></label> <Button variant="secondary" disabled={disabled || !historyVersion} onClick={() => { void (async () => { if (active.current)
        return; active.current = true; setBusy(true); setError(''); try {
        const old = await digitalRequest<Standard>(`sla-settings?version=${historyVersion}`);
        validateDigitalSlaValues(old.values);
        if (live.current) {
            setValues(old.values);
            if(readOnly)setViewVersion(old.version);
            setPreview(null);
            setNotice(readOnly?`已读取 v${old.version} 历史标准。`:`已复制 v${old.version} 到草稿，须预览后另行发布。`);
        }
    }
    finally {
        active.current = false;
        if (live.current)
            setBusy(false);
    } })().catch(e => setError(e.message)); }}>{readOnly?'查看历史标准':'复制该版本到草稿'}</Button></details>
  {!readOnly&&<><label className="sla-change-reason">调整原因<input maxLength={1000} value={reason} disabled={disabled} onChange={e => { setReason(e.target.value); setPreview(null); }}/></label>
  <Button disabled={disabled || !dirty || !reason.trim()} onClick={() => void execute(false)}>预览新单标准</Button>
  {preview && <section aria-label="发布预览" className="sla-publish-preview"><h3>确认发布 {preview.changes.length} 项变化</h3><p>仅新订单采用。在途、已完成订单和历史记录不变。</p><ul>{preview.changes.map(c => <li key={c.key}>{c.label}：{slaValueLabel(c.before)} → {slaValueLabel(c.after)}</li>)}</ul><Button disabled={busy} onClick={() => void execute(true)}>{uncertain ? '用原命令确认结果' : busy ? '正在发布…' : '确认发布新单标准'}</Button></section>}
  <SlaOrderApplicationPanel version={current.version} parameterKeys={selected} disabled={busy || uncertain || dirty} onPendingChange={setOrderPending}/></>}
 </section>;
}
