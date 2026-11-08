import {SlaAdjustmentPreview,type SlaAdjustmentComparison} from './sla-adjustment-preview.js';
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
import {mergeSavedSettings,useSlaSavedDraft} from './use-sla-saved-draft.js';
import {SlaCommonFields} from './sla-common-fields.js';
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
export function SlaStandardEditor({calculationReady=true,onWritePendingChange,externalWritePending=false,comparison=null,view='standard',historyOpen,onHistoryOpenChange,onViewChange,stageTimes=[],readOnly=false,onDraftSnapshot,beforePreview,onFilterChange,onInitialReadSettled,calculationSummary,onAuthorityChanged}:{calculationReady?:boolean;onWritePendingChange?(pending:boolean):void;externalWritePending?:boolean;comparison?:SlaAdjustmentComparison|null;view?:'standard'|'reminders'|'development';historyOpen?:boolean;onHistoryOpenChange?(open:boolean):void;onViewChange?(view:'standard'|'reminders'|'development'):void;stageTimes?:SlaStageTiming[];readOnly?:boolean;onDraftSnapshot?(snapshot:SlaDraftSnapshot<DigitalSlaValues>|null):void;beforePreview?():Promise<boolean>;onFilterChange?(stage:number,query:string):void;onInitialReadSettled?():void;calculationSummary?:string;onAuthorityChanged?():void}={}) {
    const [current, setCurrent] = useState<Standard | null>(null), [values, setValues] = useState<DigitalSlaValues>({}), [stage, setStage] = useState(2), [query, setQuery] = useState(''), [selected, setSelected] = useState<string[]>([]), [reason, setReason] = useState(''), [preview, setPreview] = useState<Preview | null>(null), [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false), [orderPending, setOrderPending] = useState(false), [historyVersion, setHistoryVersion] = useState('');
    const [viewVersion,setViewVersion]=useState<number|null>(null),[draftPreview,setDraftPreview]=useState(false),[baselineStale,setBaselineStale]=useState(false),[editReset,setEditReset]=useState(0);
    const savedDraft=useSlaSavedDraft('unified',readOnly,onAuthorityChanged);
    const [fieldErrors,setFieldErrors]=useState<Record<string,string>>({}),[editKey,setEditKey]=useState<string|null>(null),[publishedVersion,setPublishedVersion]=useState<number|null>(null),[conflict,setConflict]=useState(false);
    const editReturn=useRef<HTMLButtonElement|null>(null),editOriginal=useRef<DigitalSlaValue|null>(null),commonOriginal=useRef<DigitalSlaValues|null>(null),historyRegion=useRef<HTMLDetailsElement>(null);
    useEffect(()=>{if(historyOpen&&view!=='development')historyRegion.current?.scrollIntoView({block:'nearest'});},[historyOpen,view]);
    const errors=useMemo(()=>({...slaDraftErrors(values),...fieldErrors}),[values,fieldErrors]);
    const pending = useRef<{
        body: unknown;
        key: string;
    } | null>(null), active = useRef(false), live = useRef(true), loadSequence = useRef(0);
    const load = async (preserveDraft=false) => { const sequence = ++loadSequence.current; const row = await digitalRequest<Standard>('sla-settings'); if (!Number.isInteger(row.version) || row.scope !== 'new_orders')
        throw new Error('标准返回不完整，请刷新'); validateDigitalSlaValues(row.values);const head=await savedDraft.read();if(head&&head.currentStandardVersion!==row.version)throw Error('读取期间标准已更新，请重新读取');const restored=head?.draft;if(restored&&restored.group!=='unified')throw Error('未读到本类别草稿');if (live.current && sequence === loadSequence.current) {
        if(preserveDraft&&current){if(editKey&&editOriginal.current&&JSON.stringify(editOriginal.current)===JSON.stringify(current.values[editKey]))editOriginal.current=structuredClone(row.values[editKey]!);if(commonOriginal.current)commonOriginal.current=Object.fromEntries(Object.entries(commonOriginal.current).map(([key,value])=>[key,JSON.stringify(value)===JSON.stringify(current.values[key])?structuredClone(row.values[key]!):value]));}
        setCurrent(row);setBaselineStale(false);
        setViewVersion(row.version);
        setValues(preserveDraft&&current?Object.fromEntries(DIGITAL_SLA_PARAMETERS.map(p=>[p.key,JSON.stringify(current.values[p.key])!==JSON.stringify(values[p.key])?values[p.key]!:row.values[p.key]!])):restored?restored.expectedVersion===row.version?restored.values:mergeSavedSettings(row.values,restored):row.values);
        if(!preserveDraft)setReason(restored?.reason??'');
        if(restored&&restored.expectedVersion!==row.version){setConflict(true);setNotice('已恢复你的草稿；现行标准已变化，未修改项沿用新值。请核对后重新保存。');}
        if(!preserveDraft){setFieldErrors({});setEditKey(null);}
        setPublishedVersion(null);
        setPreview(null);
        setSelected([]);
    } };
    useEffect(() => { live.current = true; void load().catch(e => { if (live.current)
        setError(e.message); }).finally(()=>{if(live.current)onInitialReadSettled?.();}); return () => { live.current = false; }; }, []);
    useEffect(()=>{onFilterChange?.(stage,query);},[stage,query,onFilterChange]);
    const dirty = !readOnly && !!current && (JSON.stringify(current.values) !== JSON.stringify(values)||Object.keys(fieldErrors).length>0);
    const persisted=Boolean(current&&savedDraft.savedFor(current.version,values,reason));
    useDigitalDetailNavigationGuard(dirty&&!persisted&&publishedVersion===null||uncertain||savedDraft.unknown,busy||savedDraft.busy,active,'仍有未保存的时效修改或原提交结果待确认，仍要离开？');
    useEffect(()=>{onDraftSnapshot?.(current&&!baselineStale?{version:current.version,current:current.values,values,errors,publishedVersion,readOnly,resultUnknown:uncertain,draftResultUnknown:savedDraft.unknown}:null);},[current,values,errors,publishedVersion,readOnly,uncertain,savedDraft.unknown,baselineStale,onDraftSnapshot]);
    const change = (key: string, value: DigitalSlaValue) => {if(active.current||savedDraft.unknown||externalWritePending)return;setValues(v => ({ ...v, [key]: value }));setFieldErrors(previous=>Object.fromEntries(Object.entries(previous).filter(([field])=>field!==key))); setPreview(null); setNotice(''); };
    const saveDraft=async()=>{if(readOnly||externalWritePending||baselineStale||active.current||!current)return false;active.current=true;setBusy(true);setError('');try{if(Object.keys(errors).length)throw Error(Object.values(errors).join('；'));onWritePendingChange?.(true);const result=await savedDraft.save(current.version,values,reason);setNotice('草稿已保存，尚未发布；刷新后可继续修改。');if(result.currentStandardVersion!==current.version){try{await load(true);setConflict(true);setError('草稿已保存，现行标准已有变化；已保留你的修改，请核对后重新保存。');}catch{setCurrent(null);setError('草稿已保存，读取最新标准失败；请重新读取，不要重新提交保存。');}}setPreview(null);return true;}catch(error){if(error instanceof DigitalRequestError&&error.status===409){setBaselineStale(true);setConflict(true);try{await load(true);setError('现行标准或个人草稿已有变化。你的修改已保留，请核对后重新保存。');}catch{setError('现行标准或个人草稿已变化，读取最新值失败。请核对新标准，原输入仍保留。');}}else setError((error as Error).message);return false;}finally{onWritePendingChange?.(false);active.current=false;if(live.current)setBusy(false);}};
    const discardDraft=async()=>{if(readOnly||externalWritePending||active.current||!current)return;active.current=true;setBusy(true);setError('');try{onWritePendingChange?.(true);const result=await savedDraft.discard();if(result.superseded)throw Error('另一窗口已有新草稿，已保留；请重新读取后核对。');await load();setFieldErrors({});setPreview(null);setConflict(false);setNotice('草稿已取消，已读取现行标准。');}catch(error){setError((error as Error).message);}finally{onWritePendingChange?.(false);active.current=false;if(live.current)setBusy(false);}};
    const openDraftPreview=async()=>{if(readOnly||externalWritePending||active.current||!current)return;active.current=true;setBusy(true);setError('');try{if(Object.keys(errors).length)throw Error(Object.values(errors).join('；'));if(beforePreview&&!await beforePreview())throw Error('试算依据已更新，请核对后再预览');setDraftPreview(true);}catch(error){setError((error as Error).message);}finally{onWritePendingChange?.(false);active.current=false;if(live.current)setBusy(false);}};
    const execute = async (publish: boolean) => {
        if (readOnly || externalWritePending || active.current || !current || publishedVersion!==null)
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
                onWritePendingChange?.(true);
                if (!pending.current) {
                    if (!preview)
                        throw new Error('请先预览');
                    pending.current = { body: { ...draft, previewToken: preview.token,...(savedDraft.savedRevision(current.version,values,reason)?{savedDraftRevision:savedDraft.savedRevision(current.version,values,reason)}:{}) }, key: createClientRequestId() };
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
            if(e instanceof DigitalRequestError&&e.status===409){setBaselineStale(true);try{await load(true);setConflict(true);setError('现行标准已有新版本。你的修改已保留；请核对新值与本次草稿，再重新预览确认。');}catch{setError('现行标准已有新版本，草稿仍保留；读取最新值失败，请稍后重试。');}}
            if (publish && pending.current && e instanceof DigitalRequestError && e.resultUnknown)
                setUncertain(true);
            else if (publish) {
                pending.current = null;
                setUncertain(false);
                setPreview(null);
            }
        }
        finally {
            if(publish)onWritePendingChange?.(false);
            active.current = false;
            if (live.current)
                setBusy(false);
        }
    };
    if (!current)
        return <section className="cockpit-settings-node-section">{error ? <><p role="alert">{error}</p><Button disabled={busy} onClick={()=>{setBusy(true);void load().then(()=>setError('')).catch(error=>setError(error.message)).finally(()=>{if(live.current)setBusy(false);});}}>重试读取统一标准</Button></> : <p>正在读取时效标准…</p>}</section>;
    const rows = DIGITAL_SLA_PARAMETERS.filter(p => view==='reminders' ? ['warning_ratio','ship_sample_advance','order_shipping_reminder'].includes(p.key) : query ? p.label.includes(query) : stage === 0 ? p.stage === 0 || ['ship_sample_advance', 'order_shipping_reminder'].includes(p.key) : p.stage === stage), chosen = DIGITAL_SLA_PARAMETERS.filter(p => selected.includes(p.key)), first = chosen[0], batchValid = !!first && chosen.every(p => batchGroup(p.key, values[p.key]!) === batchGroup(first.key, values[first.key]!));
    const disabled = baselineStale || externalWritePending || busy || uncertain || savedDraft.unknown || savedDraft.busy || orderPending || publishedVersion!==null;
    const selectedTime=stageTimes.find(time=>time.stage===stage);
    const renderRow=(p:typeof DIGITAL_SLA_PARAMETERS[number],index:number)=>{const value=values[p.key]!,warning=values.warning_ratio,reminder=value.kind==='duration'&&warning?.kind==='ratio'?(warning.notificationEnabled===false?'临期提醒关闭':`用时${warning.percent}%时提醒`):value.kind==='included'?'沿所属窗口':value.kind==='ratio'?(value.notificationEnabled===false?'临期提醒关闭':`用时${value.percent}%时提醒`):value.kind==='offset'?`提前${value.days}天`:'—';return <tr key={p.key} data-sla-node={p.key} data-sla-kind={value.kind} aria-selected={editKey===p.key}><td>{!readOnly&&<input type="checkbox" aria-label={`选择${p.label}参与批量调整`} disabled={disabled||!editable(value)} checked={selected.includes(p.key)} onChange={e=>setSelected(keys=>e.target.checked?[...keys,p.key]:keys.filter(key=>key!==p.key))}/>}<span>{index+1}</span></td><th scope="row">{p.label}{errors[p.key]&&<small role="alert">{errors[p.key]}</small>}</th><td>{slaValueLabel(value)}{JSON.stringify(value)!==JSON.stringify(current.values[p.key])&&<small>现行 {slaValueLabel(current.values[p.key]!)}</small>}</td><td>{reminder}</td>{view==='reminders'&&<td>{['warning_ratio','ship_sample_advance'].includes(p.key)&&(value.kind==='ratio'||value.kind==='offset')?<input type="checkbox" role="switch" aria-label={p.label+'提醒启用'} checked={value.notificationEnabled!==false} disabled={disabled||readOnly} onChange={event=>{const next={...value};if(event.target.checked&&!('notificationEnabled'in current.values[p.key]!))delete next.notificationEnabled;else next.notificationEnabled=event.target.checked;change(p.key,next);}}/>:<span>页面提示</span>}</td>}<td><Button variant="secondary" disabled={disabled} aria-label={`${readOnly?'查看':'调整'}${p.label}`} onClick={event=>{editReturn.current=event.currentTarget;editOriginal.current=structuredClone(value);commonOriginal.current={warning_ratio:structuredClone(values.warning_ratio!),stage_buffer:structuredClone(values.stage_buffer!)};setEditKey(p.key);}}>{readOnly?'查看':editable(value)?'编辑':'查看'}</Button>{!readOnly&&(JSON.stringify(value)!==JSON.stringify(current.values[p.key])||fieldErrors[p.key])&&<Button variant="secondary" disabled={disabled} aria-label={`撤销${p.label}修改`} onClick={()=>{change(p.key,current.values[p.key]!);if(editKey===p.key)setEditReset(n=>n+1);}}>撤销</Button>}</td></tr>;};
    return <div className="sla-standard-editor">{draftPreview&&<SlaAdjustmentPreview disabled={baselineStale} comparison={comparison} stage={stage} busy={busy} error={error} onClose={()=>setDraftPreview(false)} onSave={saveDraft}/>}<section className="cockpit-settings-node-section sla-stage-selector" aria-label="时效阶段选择">  <div className="cockpit-policy-stage-scroll" role="region" aria-label="阶段用时对比"><ol className="cockpit-policy-stages" aria-label="时效阶段">{JOURNEY_STAGES.map((p,i)=>{const time=stageTimes.find(t=>t.stage===i+1),format=(v:number|null)=>calculationSpanLabel(v,readableSlaMinutes);return <li className="sla-stage-time-item" key={p.key}><button type="button" aria-label={p.label} aria-pressed={view==='development'?i===1:stage===i+1} onClick={()=>{if(view==='development')onViewChange?.('standard');setStage(i+1);setQuery('');}}><span className="cockpit-policy-stage-ring"><svg viewBox="0 0 72 72" aria-hidden="true"><circle cx="36" cy="36" r="30"/><circle cx="36" cy="36" r="30"/></svg><b>{i+1}</b></span><strong>{p.label}</strong>{time?.draftMs!=null?<small>用时 {format(time.draftMs)+(time.partial?'（部分待核）':'')}</small>:time?.draftKnownPathMs!=null?<small className="sla-known-path">可算路径 {format(time.draftKnownPathMs)}</small>:<small>用时 —</small>}</button></li>;})}</ol></div></section><section className="cockpit-settings-node-section sla-stage-nodes" hidden={view==='development'} aria-label="统一时效标准">
  {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
  <details className="sla-settings-tools"><summary>查找节点与版本</summary>
  <div className="sla-standard-version"><span>统一标准 v{readOnly?viewVersion??current.version:current.version}</span></div>
  <div className="sla-standard-toolbar"><label>查找节点 <input type="search" value={query} placeholder="例如：印花、装箱" onChange={e => setQuery(e.target.value)}/></label><Button variant="secondary" disabled={busy||uncertain||savedDraft.unknown||orderPending} onClick={() => { void (async () => { if (active.current)
        return; if (!baselineStale && dirty && publishedVersion===null && !await confirmInApp('放弃未发布草稿，读取现行标准？', { title: '读取现行标准', confirmLabel: '放弃草稿并读取' }))
        return; active.current = true; setBusy(true); try {
        await load(baselineStale);setError('');
    }
    finally {
        active.current = false;
        if (live.current)
            setBusy(false);
    } })().catch(e => setError(e.message)); }}>{baselineStale?'核对新标准并保留修改':'读取现行标准'}</Button></div>

  <div className="sla-standard-toolbar"><Button variant="secondary" aria-pressed={stage===0} onClick={()=>{setStage(0);setQuery('');}}>通用评价与交付提醒</Button>{dirty&&<span role="status">{publishedVersion===null?'本次草稿未发布':`本次草稿已发布v${publishedVersion}，最新标准尚待读取校准`}</span>}</div>
  </details>
  {conflict&&<section aria-label="版本冲突对比"><h3>他人已发布的新值／我的修改</h3><ul>{DIGITAL_SLA_PARAMETERS.filter(p=>JSON.stringify(values[p.key])!==JSON.stringify(current.values[p.key])).map(p=><li key={p.key}>{p.label}：新现行 {slaValueLabel(current.values[p.key]!)} → 我的草稿 {slaValueLabel(values[p.key]!)}</li>)}</ul><p>其余未修改字段已沿用新现行值；需要重新预览并确认，不能直接覆盖。</p></section>}

  {!readOnly && chosen.length > 0 && <div className="sla-standard-toolbar"><span>已选 {chosen.length} 项</span>{chosen.length > 1 && <Button variant="secondary" disabled={disabled || !batchValid} onClick={() => { if (!first)
        return; setValues(v => ({ ...v, ...Object.fromEntries(chosen.map(p => [p.key, { ...v[first.key]! }])) })); setPreview(null); }}>统一为“{first?.label}”的数值</Button>}<Button variant="secondary" onClick={() => setSelected([])}>清空选择</Button>{!batchValid && <small>只可统一同一种时效，不混算提前量、工时与物流预计。</small>}</div>}


  <div className="sla-node-editor-grid"><div className="sla-node-table-panel"><div className="sla-selected-stage-title"><h2>{view==='reminders'?'提醒规则':'本阶段节点'}</h2><strong>{selectedTime?.draftMs!=null?'本阶段用时 '+calculationSpanLabel(selectedTime.draftMs,readableSlaMinutes)+(selectedTime.partial?'（部分待核）':''):selectedTime?.draftKnownPathMs!=null?'可算路径 '+calculationSpanLabel(selectedTime.draftKnownPathMs,readableSlaMinutes):'本阶段用时 —'}</strong></div><div className="sla-node-table-scroll" role="region" tabIndex={0} aria-label="本阶段节点与标准用时"><table><thead><tr><th>序号</th><th>{view==='reminders'?'提醒名称':'节点'}</th><th>{view==='reminders'?'阈值':'标准用时'}</th><th>提醒时间</th>{view==='reminders'&&<th>启用</th>}<th>操作</th></tr></thead><tbody>{rows.map(renderRow)}</tbody></table></div></div><div className="sla-node-edit-column">  {editKey&&<SlaNodeEditDialog keepDisabled={!calculationReady} resetVersion={editReset} inline returnFocusTo={editReturn.current} disabled={disabled} keepLabel="预览调整结果" key={`${editKey}:${current.version}`} label={DIGITAL_SLA_PARAMETERS.find(p=>p.key===editKey)!.label} value={values[editKey]!} current={current.values[editKey]!} source={`统一标准v${current.version} · ${slaParameterHints[editKey]}`} readOnly={readOnly} onInput={(value,error)=>{if(value)change(editKey,value);else{setFieldErrors(previous=>({...previous,[editKey]:error??'请补齐本字段'}));setPreview(null);}}} onCancel={()=>{if(!readOnly&&editOriginal.current){change(editKey,editOriginal.current);if(commonOriginal.current)for(const [key,value]of Object.entries(commonOriginal.current))change(key,value);}setEditKey(null);}} onKeep={()=>void openDraftPreview()}><p role="alert">{errors[editKey]}</p><p aria-live="polite">{calculationSummary??'本次用时依据正在读取，请保留草稿后核对。'}</p>{view==='reminders'&&<dl className="sla-reminder-scope"><div><dt>适用范围</dt><dd>{editKey==='warning_ratio'?'未完成且有独立时限的节点':editKey==='ship_sample_advance'?'本单适用PO的船样目标':'本单有客户交期的PO'}</dd></div><div><dt>接收对象</dt><dd>{editKey==='warning_ratio'?'原节点主办与监督岗位':editKey==='ship_sample_advance'?'本单主跟单与生产管理':'仅页面提示，无独立通知'}</dd></div><div><dt>采用方式</dt><dd>新单采用；在办规则保持。期限与原通知历史不变。</dd></div>{editKey==='warning_ratio'&&<div><dt>关闭影响</dt><dd>不再触发该临期通知；逾期提醒和待办保持。</dd></div>}</dl>}{view==='standard'&&stage>0&&<SlaCommonFields key={`${editKey}:${current.version}`} values={values} disabled={readOnly||disabled} onInput={(key,value,message)=>{if(value)change(key,value);else{setFieldErrors(previous=>({...previous,[key]:message??'请补齐本字段'}));setPreview(null);}}}/>}<label>本次调整原因<input aria-label="调整原因" maxLength={1000} value={reason} disabled={readOnly||disabled} onChange={e=>{setReason(e.target.value);setPreview(null);}}/></label></SlaNodeEditDialog>}{!editKey&&<aside className="sla-node-inline-placeholder"><h2>选中节点</h2><p>选择左侧节点，查看或调整当前标准。</p></aside>}</div></div>

  {!rows.length && <p>统一标准中没有匹配节点。</p>}
  <details ref={historyRegion} className="sla-settings-help sla-history-settings" open={historyOpen} onToggle={event=>onHistoryOpenChange?.(event.currentTarget.open)}><summary>计算规则与历史</summary><p>连续自然时间，包含正常等待。内含项目不重复相加；阶段时长由适用路径计算，串行相加、并行取最长。这里不能关闭业务条件。日期目标按北京时间当天结束；具体时刻按原精度判断。</p>{!readOnly&&<p>选择跨阶段的同类节点，可统一使用其中一项数值；提前量、临期比例、预计物流不混算。未知实际时间保持未知。</p>}<details><summary>当前节点起止口径</summary><ul>{rows.map(p => <li key={p.key}><strong>{p.label}</strong>：{slaParameterHints[p.key]}</li>)}</ul></details>{!readOnly&&<><Button variant="secondary" disabled={disabled} onClick={() => { setValues(digitalSlaDefaults()); setPreview(null); }}>把初始标准复制到草稿</Button><p>复制不会直接发布，也不改历史实际或已有订单。</p></>}<label>历史标准 <select aria-label="选择历史标准" disabled={disabled} value={historyVersion} onChange={e => setHistoryVersion(e.target.value)}><option value="">选择已发布版本</option>{current.history.map(h => <option key={h.version} value={h.version}>v{h.version} · {h.reason}</option>)}</select></label> <Button variant="secondary" disabled={disabled || !historyVersion} onClick={() => { void (async () => { if (active.current)
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
  {!readOnly&&<><div className="sla-publish-controls">{!editKey&&<label className="sla-change-reason">调整原因<input maxLength={1000} value={reason} disabled={disabled} onChange={e => { setReason(e.target.value); setPreview(null); }}/></label>}
  <span role="status">已修改 {DIGITAL_SLA_PARAMETERS.filter(p=>JSON.stringify(values[p.key])!==JSON.stringify(current.values[p.key])).length} 项{persisted?" · 草稿已保存":""}</span><Button variant="secondary" aria-label="撤销本次全部修改" disabled={disabled||(!dirty&&!savedDraft.head?.draft)} onClick={()=>void discardDraft()}>取消</Button><Button variant="secondary" disabled={!savedDraft.unknown&&!calculationReady||baselineStale||busy||uncertain||orderPending||publishedVersion!==null||(!dirty&&!savedDraft.unknown)||Object.keys(errors).length>0} onClick={()=>void(savedDraft.unknown?savedDraft.pendingKind==='discard'?discardDraft():saveDraft():openDraftPreview())}>{savedDraft.unknown?savedDraft.pendingKind==='discard'?"用原命令确认草稿取消":"用原命令确认草稿保存":"保存草稿"}</Button>
  {(persisted||uncertain||preview!==null)&&<Button variant="primary" disabled={!calculationReady || disabled || !dirty || !persisted || !reason.trim() || Object.keys(errors).length>0} onClick={() => void execute(false)}>预览新单标准</Button>}</div>
  {preview && <section aria-label="发布预览" className="sla-publish-preview"><h3>确认发布 {preview.changes.length} 项变化</h3><p>仅新订单采用。在途、已完成订单和历史记录不变。</p><ul>{preview.changes.map(c => <li key={c.key}>{c.label}：{slaValueLabel(c.before)} → {slaValueLabel(c.after)}</li>)}</ul><Button disabled={busy||!uncertain&&!calculationReady} onClick={() => void execute(true)}>{uncertain ? '用原命令确认结果' : busy ? '正在发布…' : '确认发布新单标准'}</Button></section>}
  <details className="sla-settings-help"><summary>指定在途订单采用</summary><SlaOrderApplicationPanel version={current.version} parameterKeys={selected} disabled={baselineStale || busy || uncertain || savedDraft.unknown || dirty || publishedVersion!==null} onPendingChange={setOrderPending}/></details></>}
  <details className="sla-settings-help"><summary>独立规则与原业务入口</summary><p>新采纳制单草稿／正式两个24小时窗口沿原采用与各自起点，历史保留制单继续使用旧72小时。每PO／加工厂的原质检、合同48业务小时、物料提前提醒及短交期审批按各自原入口办理；这些不是统一45项草稿，不能用本页普通发布或在途应用替代。</p></details>

 </section></div>;
}
