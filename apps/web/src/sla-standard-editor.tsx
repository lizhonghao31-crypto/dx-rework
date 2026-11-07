import {NavigationIcon} from './navigation-icons.js';
import { slaParameterHints } from './sla-parameter-hints.js';
import { confirmInApp } from './system-dialog.js';
import { SlaOrderApplicationPanel } from './sla-order-application-panel.js';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@dx-rework/ui';
import { JOURNEY_STAGES } from '@dx-rework/contracts/digital-production-journey';
import { DIGITAL_SLA_PARAMETERS, digitalSlaDefaults, validateDigitalSlaValues, type DigitalSlaValue, type DigitalSlaValues } from '@dx-rework/contracts/digital-sla';
import { digitalRequest, DigitalRequestError } from './digital-production-api.js';
import { createClientRequestId } from './client-request-id.js';
import {useDigitalDetailNavigationGuard} from './use-digital-detail-navigation-guard.js';
import {calculationSpanLabel,type SlaStageTiming} from './sla-calculation-preview-model.js';
import {SlaNodeEditDialog} from './sla-node-edit-dialog.js';
import {readableSlaMinutes,readableSlaValue,slaDraftErrors,type SlaDraftSnapshot} from './sla-settings-draft.js';
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
export const slaValueLabel = readableSlaValue;
export function SlaStandardEditor({stageTimes=[],readOnly=false,onDraftSnapshot,beforePreview,onFilterChange,onInitialReadSettled,calculationSummary,onAuthorityChanged}:{stageTimes?:SlaStageTiming[];readOnly?:boolean;onDraftSnapshot?(snapshot:SlaDraftSnapshot<DigitalSlaValues>):void;beforePreview?():Promise<boolean>;onFilterChange?(stage:number,query:string):void;onInitialReadSettled?():void;calculationSummary?:string;onAuthorityChanged?():void}={}) {
    const [current, setCurrent] = useState<Standard | null>(null), [values, setValues] = useState<DigitalSlaValues>({}), [stage, setStage] = useState(2), [query, setQuery] = useState(''), [selected, setSelected] = useState<string[]>([]), [reason, setReason] = useState(''), [preview, setPreview] = useState<Preview | null>(null), [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false), [orderPending, setOrderPending] = useState(false), [historyVersion, setHistoryVersion] = useState('');
    const [viewVersion,setViewVersion]=useState<number|null>(null);
    const [fieldErrors,setFieldErrors]=useState<Record<string,string>>({}),[editKey,setEditKey]=useState<string|null>(null),[publishedVersion,setPublishedVersion]=useState<number|null>(null),[conflict,setConflict]=useState(false);
    const editOriginal=useRef<DigitalSlaValue|null>(null);
    const errors=useMemo(()=>({...slaDraftErrors(values),...fieldErrors}),[values,fieldErrors]);
    const pending = useRef<{
        body: unknown;
        key: string;
    } | null>(null), active = useRef(false), live = useRef(true), loadSequence = useRef(0);
    const load = async (preserveDraft=false) => { const sequence = ++loadSequence.current; const row = await digitalRequest<Standard>('sla-settings'); if (!Number.isInteger(row.version) || row.scope !== 'new_orders')
        throw new Error('标准返回不完整，请刷新'); validateDigitalSlaValues(row.values); if (live.current && sequence === loadSequence.current) {
        setCurrent(row);
        setViewVersion(row.version);
        setValues(preserveDraft&&current?Object.fromEntries(DIGITAL_SLA_PARAMETERS.map(p=>[p.key,JSON.stringify(current.values[p.key])!==JSON.stringify(values[p.key])?values[p.key]!:row.values[p.key]!])):row.values);
        if(!preserveDraft)setFieldErrors({});
        setPublishedVersion(null);
        setPreview(null);
        setSelected([]);
    } };
    useEffect(() => { live.current = true; void load().catch(e => { if (live.current)
        setError(e.message); }).finally(()=>{if(live.current)onInitialReadSettled?.();}); return () => { live.current = false; }; }, []);
    useEffect(()=>{onFilterChange?.(stage,query);},[stage,query,onFilterChange]);
    const dirty = !readOnly && !!current && (JSON.stringify(current.values) !== JSON.stringify(values)||Object.keys(fieldErrors).length>0);
    useDigitalDetailNavigationGuard(dirty&&publishedVersion===null||uncertain,busy,active,'时效草稿尚未发布或原提交结果尚未确认，仍要离开？');
    useEffect(()=>{if(current)onDraftSnapshot?.({version:current.version,current:current.values,values,errors,publishedVersion,readOnly,resultUnknown:uncertain});},[current,values,errors,publishedVersion,readOnly,uncertain,onDraftSnapshot]);
    const change = (key: string, value: DigitalSlaValue) => { setValues(v => ({ ...v, [key]: value }));setFieldErrors(previous=>Object.fromEntries(Object.entries(previous).filter(([field])=>field!==key))); setPreview(null); setNotice(''); };
    const execute = async (publish: boolean) => {
        if (readOnly || active.current || !current || publishedVersion!==null)
            return;
        active.current = true;
        setBusy(true);
        setError('');
        try {
            if(Object.keys(errors).length)throw Error(Object.values(errors).join('；'));
            validateDigitalSlaValues(values);
            if(!pending.current&&beforePreview&&!await beforePreview())throw Error('本次演算依据已更新，请核对结果后重新预览');
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
                setPublishedVersion(result.version);
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
                setConflict(false);
            }
        }
        catch (e) {
            setError(e instanceof Error ? e.message : '操作失败');if(live.current&&e instanceof DigitalRequestError&&[401,403].includes(e.status??0))onAuthorityChanged?.();
            if(e instanceof DigitalRequestError&&e.status===409){try{await load(true);setConflict(true);setError('现行标准已有新版本。你的修改已保留；请核对新值与本次草稿，再重新预览确认。');}catch{setError('现行标准已有新版本，草稿仍保留；读取最新值失败，请稍后重试。');}}
            if (publish && pending.current && e instanceof DigitalRequestError && e.resultUnknown)
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
        return <section className="cockpit-settings-node-section">{error ? <><p role="alert">{error}</p><Button disabled={busy} onClick={()=>{setBusy(true);void load().then(()=>setError('')).catch(error=>setError(error.message)).finally(()=>{if(live.current)setBusy(false);});}}>重试读取统一标准</Button></> : <p>正在读取时效标准…</p>}</section>;
    const rows = DIGITAL_SLA_PARAMETERS.filter(p => query ? p.label.includes(query) : stage === 0 ? p.stage === 0 || ['ship_sample_advance', 'order_shipping_reminder'].includes(p.key) : p.stage === stage), chosen = DIGITAL_SLA_PARAMETERS.filter(p => selected.includes(p.key)), first = chosen[0], batchValid = !!first && chosen.every(p => batchGroup(p.key, values[p.key]!) === batchGroup(first.key, values[first.key]!));
    const disabled = busy || uncertain || orderPending || publishedVersion!==null;
    const selectedTime=stageTimes.find(time=>time.stage===stage);
    const secondaryKinds=new Set(['included','unlimited','order_date','offset']);
    const renderCard=(p:typeof DIGITAL_SLA_PARAMETERS[number])=><li key={p.key} data-sla-node={p.key} data-sla-kind={values[p.key]!.kind}>{!readOnly&&<input type="checkbox" aria-label={`选择${p.label}参与批量调整`} disabled={disabled||!editable(values[p.key]!)} checked={selected.includes(p.key)} onChange={e=>setSelected(keys=>e.target.checked?[...keys,p.key]:keys.filter(key=>key!==p.key))}/>}<span className="cockpit-policy-card-icon" aria-hidden="true"><NavigationIcon name="FileText"/></span><div><h3>{p.label}</h3><strong>{slaValueLabel(values[p.key]!)}</strong>{JSON.stringify(values[p.key])!==JSON.stringify(current.values[p.key])&&<small>现行 {slaValueLabel(current.values[p.key]!)} → 本次草稿</small>}{p.defaultValue.kind!=='duration'&&<small>{p.defaultValue.kind==='included'?'计入父窗口':p.defaultValue.kind==='estimate'?'仅物流预计':p.defaultValue.kind==='offset'?'日期提醒':p.defaultValue.kind==='order_date'?'原约定日期':'等待原事件'}</small>}{errors[p.key]&&<small role="alert">{errors[p.key]}</small>}</div><div className="sla-node-card-actions"><Button variant="secondary" disabled={disabled} aria-label={`${readOnly?'查看':'调整'}${p.label}`} onClick={()=>{editOriginal.current=structuredClone(values[p.key]!);setEditKey(p.key);}}>{readOnly?'查看':'编辑'}</Button>{!readOnly&&(JSON.stringify(values[p.key])!==JSON.stringify(current.values[p.key])||fieldErrors[p.key])&&<Button variant="secondary" disabled={disabled} aria-label={`撤销${p.label}修改`} onClick={()=>change(p.key,current.values[p.key]!)}>撤销</Button>}</div></li>;
    return <div className="sla-standard-editor"><section className="cockpit-settings-node-section sla-stage-selector" aria-label="时效阶段选择">  <div className="cockpit-policy-stage-scroll" role="region" aria-label="阶段用时对比"><ol className="cockpit-policy-stages" aria-label="时效阶段">{JOURNEY_STAGES.map((p,i)=>{const time=stageTimes.find(t=>t.stage===i+1),format=(v:number|null)=>calculationSpanLabel(v,readableSlaMinutes);return <li className="sla-stage-time-item" key={p.key}><button type="button" aria-label={p.label} aria-pressed={stage===i+1} onClick={()=>{setStage(i+1);setQuery('');}}><span className="cockpit-policy-stage-ring"><svg viewBox="0 0 72 72" aria-hidden="true"><circle cx="36" cy="36" r="30"/><circle cx="36" cy="36" r="30"/></svg><b>{i+1}</b></span><strong>{p.label}</strong><small>用时 {time?.draftMs!=null?format(time.draftMs)+(time.partial?'（部分待核）':''):'—'}</small>{time?.draftMs==null&&time?.draftKnownPathMs!=null&&<small className="sla-known-path">可算路径 {format(time.draftKnownPathMs)}</small>}</button></li>;})}</ol></div></section><section className="cockpit-settings-node-section sla-stage-nodes" aria-label="统一时效标准">  <div className="sla-selected-stage-title"><h2>{stage===0?'通用评价与交付提醒':JOURNEY_STAGES[stage-1]?.label}</h2><strong>本阶段用时 {selectedTime?.draftMs!=null?calculationSpanLabel(selectedTime.draftMs,readableSlaMinutes)+(selectedTime.partial?'（部分待核）':''):'—'}</strong></div>
  {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
  <details className="sla-settings-tools"><summary>查找节点与版本</summary>
  <div className="sla-standard-version"><span>统一标准 v{readOnly?viewVersion??current.version:current.version}</span></div>
  <div className="sla-standard-toolbar"><label>查找节点 <input type="search" value={query} placeholder="例如：印花、装箱" onChange={e => setQuery(e.target.value)}/></label><Button variant="secondary" disabled={busy||uncertain||orderPending} onClick={() => { void (async () => { if (active.current)
        return; if (dirty && publishedVersion===null && !await confirmInApp('放弃未发布草稿，读取现行标准？', { title: '读取现行标准', confirmLabel: '放弃草稿并读取' }))
        return; active.current = true; setBusy(true); try {
        await load();
    }
    finally {
        active.current = false;
        if (live.current)
            setBusy(false);
    } })().catch(e => setError(e.message)); }}>读取现行标准</Button></div>

  <div className="sla-standard-toolbar"><Button variant="secondary" aria-pressed={stage===0} onClick={()=>{setStage(0);setQuery('');}}>通用评价与交付提醒</Button>{dirty&&<span role="status">{publishedVersion===null?'本次草稿未发布':`本次草稿已发布v${publishedVersion}，最新标准尚待读取校准`}</span>}</div>
  </details>
  {conflict&&<section aria-label="版本冲突对比"><h3>他人已发布的新值／我的修改</h3><ul>{DIGITAL_SLA_PARAMETERS.filter(p=>JSON.stringify(values[p.key])!==JSON.stringify(current.values[p.key])).map(p=><li key={p.key}>{p.label}：新现行 {slaValueLabel(current.values[p.key]!)} → 我的草稿 {slaValueLabel(values[p.key]!)}</li>)}</ul><p>其余未修改字段已沿用新现行值；需要重新预览并确认，不能直接覆盖。</p></section>}

  {!readOnly && chosen.length > 0 && <div className="sla-standard-toolbar"><span>已选 {chosen.length} 项</span>{chosen.length > 1 && <Button variant="secondary" disabled={disabled || !batchValid} onClick={() => { if (!first)
        return; setValues(v => ({ ...v, ...Object.fromEntries(chosen.map(p => [p.key, { ...v[first.key]! }])) })); setPreview(null); }}>统一为“{first?.label}”的数值</Button>}<Button variant="secondary" onClick={() => setSelected([])}>清空选择</Button>{!batchValid && <small>只可统一同一种时效，不混算提前量、工时与物流预计。</small>}</div>}

  {selectedTime?.draftMs==null&&selectedTime?.draftKnownPathMs!=null&&<p className="sla-known-path">可算路径 {calculationSpanLabel(selectedTime!.draftKnownPathMs!,readableSlaMinutes)}；阶段总用时仍有待定环节。</p>}
  <ul className="cockpit-policy-cards">{rows.filter(p=>!secondaryKinds.has(values[p.key]!.kind)).map(renderCard)}</ul><ul className="cockpit-policy-cards is-secondary">{rows.filter(p=>secondaryKinds.has(values[p.key]!.kind)).map(renderCard)}</ul>

  {!rows.length && <p>统一标准中没有匹配节点。</p>}
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
  {!readOnly&&<><div className="sla-publish-controls"><label className="sla-change-reason">调整原因<input maxLength={1000} value={reason} disabled={disabled} onChange={e => { setReason(e.target.value); setPreview(null); }}/></label>
  <Button variant="secondary" aria-label="撤销本次全部修改" disabled={disabled||!dirty} onClick={()=>{setValues(current.values);setFieldErrors({});setPreview(null);setConflict(false);}}>取消</Button>
  <Button variant="primary" disabled={disabled || !dirty || !reason.trim() || Object.keys(errors).length>0} onClick={() => void execute(false)}>预览新单标准</Button></div>
  {preview && <section aria-label="发布预览" className="sla-publish-preview"><h3>确认发布 {preview.changes.length} 项变化</h3><p>仅新订单采用。在途、已完成订单和历史记录不变。</p><ul>{preview.changes.map(c => <li key={c.key}>{c.label}：{slaValueLabel(c.before)} → {slaValueLabel(c.after)}</li>)}</ul><Button disabled={busy} onClick={() => void execute(true)}>{uncertain ? '用原命令确认结果' : busy ? '正在发布…' : '确认发布新单标准'}</Button></section>}
  <details className="sla-settings-help"><summary>指定在途订单采用</summary><SlaOrderApplicationPanel version={current.version} parameterKeys={selected} disabled={busy || uncertain || dirty || publishedVersion!==null} onPendingChange={setOrderPending}/></details></>}
  <details className="sla-settings-help"><summary>独立规则与原业务入口</summary><p>新采纳制单草稿／正式两个24小时窗口沿原采用与各自起点，历史保留制单继续使用旧72小时。每PO／加工厂的原质检、合同48业务小时、物料提前提醒及短交期审批按各自原入口办理；这些不是统一45项草稿，不能用本页普通发布或在途应用替代。</p></details>
  {editKey&&<SlaNodeEditDialog key={editKey} label={DIGITAL_SLA_PARAMETERS.find(p=>p.key===editKey)!.label} value={values[editKey]!} current={current.values[editKey]!} source={`统一标准v${current.version} · ${slaParameterHints[editKey]}`} readOnly={readOnly} onInput={(value,error)=>{if(value)change(editKey,value);else{setFieldErrors(previous=>({...previous,[editKey]:error??'请补齐本字段'}));setPreview(null);}}} onCancel={()=>{if(!readOnly&&editOriginal.current)change(editKey,editOriginal.current);setEditKey(null);}} onKeep={()=>setEditKey(null)}><p role="alert">{errors[editKey]}</p><p aria-live="polite">{calculationSummary??'本次用时依据正在读取，请保留草稿后核对。'}</p><label>本次调整原因<input aria-label="节点调整原因" maxLength={1000} value={reason} disabled={readOnly} onChange={e=>{setReason(e.target.value);setPreview(null);}}/></label></SlaNodeEditDialog>}
 </section></div>;
}
