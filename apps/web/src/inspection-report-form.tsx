import type {
  InspectionCheckResultSchema,
  InspectionReportDraft,
  InspectionSizeSample,
} from "@dx-rework/contracts";
import { Button, InsetField, StatusBadge, Surface } from "@dx-rework/ui";
import { useEffect, useState } from "react";
import type { z } from "zod";

import { createClientRequestId } from "./client-request-id.js";

type CheckResult = z.infer<typeof InspectionCheckResultSchema>;
type ReportChange = (report: InspectionReportDraft) => void;

export const DEFAULT_MEASUREMENT_PARTS = [
  "衣长", "肩宽", "胸围", "腰围", "脚围", "袖长", "袖肥", "袖口", "领阔", "领围",
] as const;

const today = (): string => {
  const date = new Date();
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-");
};

const newSample = (index: number): InspectionSizeSample => ({
  sampleId: createClientRequestId(),
  sizeLabel: "M",
  sampleLabel: `第 ${index} 件`,
  measurements: DEFAULT_MEASUREMENT_PARTS.map((partName) => ({
    partName,
    actualCm: null,
    deviationCm: null,
    notApplicable: false,
  })),
});

export const createEmptyInspectionReport = (): InspectionReportDraft => ({
  schemaVersion: 1,
  styleName: null,
  inspectionStage: null,
  inspectionLocation: null,
  color: null,
  sampleQuantity: null,
  measurementUnit: "cm",
  measurementPrecision: 0.1,
  sizeSamples: [newSample(1)],
  documentChecks: {
    confirmationSample: false,
    approvalCard: false,
    supplierSelfInspection: false,
    bulkFabricInspection: false,
    exceptionReason: null,
  },
  fabricMatch: null,
  fabricMismatchReason: null,
  fitDecision: null,
  factoryPreparation: null,
  materialChecks: {
    physicalPerformance: null,
    washTest: null,
    productMarking: null,
  },
  issues: [{
    issueId: createClientRequestId(),
    category: null,
    description: null,
    majorCount: 0,
    minorCount: 0,
  }],
  nonconformanceCause: null,
  approvalOpinion: null,
  supplierSignatoryName: null,
  supplierSignedOn: null,
  inspectionDate: today(),
  disposition: "rework",
});

const present = (value: string | null): boolean => Boolean(value?.trim());

export const inspectionStepComplete = (report: InspectionReportDraft, step: 1 | 2 | 3): boolean => {
  if (step === 1) {
    return Boolean(
      report.inspectionStage
      && present(report.inspectionLocation)
      && present(report.color)
      && report.sampleQuantity
      && report.inspectionDate
      && report.sizeSamples.length > 0
      && report.sizeSamples.every((sample) => sample.measurements.every(
        (measurement) => measurement.notApplicable
          || (measurement.actualCm !== null && measurement.deviationCm !== null),
      )),
    );
  }
  if (step === 2) {
    const documents = report.documentChecks;
    const documentsComplete = documents.confirmationSample
      && documents.approvalCard
      && documents.supplierSelfInspection
      && documents.bulkFabricInspection;
    return Boolean(
      (documentsComplete || present(documents.exceptionReason))
      && report.fabricMatch
      && (report.fabricMatch !== "mismatch" || present(report.fabricMismatchReason))
      && report.fitDecision
      && report.factoryPreparation
      && Object.values(report.materialChecks).every(Boolean),
    );
  }
  return Boolean(
    present(report.nonconformanceCause)
    && report.issues.length > 0
    && report.issues.every((issue) => (
      present(issue.category)
      && present(issue.description)
      && issue.majorCount + issue.minorCount > 0
    )),
  );
};

const nullableText = (value: string): string | null => value.trim() ? value : null;
const nullableNumber = (value: string): number | null => value === "" ? null : Number(value);

export function InspectionReportStepOne({
  report,
  disabled,
  onChange,
  hideBasicFields = false,
}: {
  report: InspectionReportDraft;
  disabled: boolean;
  onChange: ReportChange;
  hideBasicFields?: boolean;
}) {
  const [selectedSampleId, setSelectedSampleId] = useState(report.sizeSamples[0]?.sampleId ?? "");
  useEffect(() => {
    if (!report.sizeSamples.some((sample) => sample.sampleId === selectedSampleId)) {
      setSelectedSampleId(report.sizeSamples[0]?.sampleId ?? "");
    }
  }, [report.sizeSamples, selectedSampleId]);
  const selected = report.sizeSamples.find((sample) => sample.sampleId === selectedSampleId) ?? report.sizeSamples[0];

  const updateSample = (next: InspectionSizeSample): void => {
    onChange({
      ...report,
      sizeSamples: report.sizeSamples.map((sample) => sample.sampleId === next.sampleId ? next : sample),
    });
  };

  return (
    <>
      {!hideBasicFields && <Surface className="inspection-section">
        <div className="section-title">
          <div><h2>验货基本资料</h2><p>本系统只登记需要返工的验货报告。</p></div>
          <StatusBadge tone="info">步骤 1/3</StatusBadge>
        </div>
        <div className="qc-form-grid inspection-basic-grid">
          <label className="dx-field">
            <span>验货阶段（必填）</span>
            <span className="dx-field__control">
              <select
                value={report.inspectionStage ?? ""}
                disabled={disabled}
                onChange={(event) => onChange({ ...report, inspectionStage: event.target.value ? event.target.value as InspectionReportDraft["inspectionStage"] : null })}
              >
                <option value="">请选择</option>
                <option value="midline">中查</option>
                <option value="final">整查</option>
                <option value="warehouse">仓检</option>
                <option value="reinspection">复检</option>
              </select>
            </span>
          </label>
          <InsetField
            label="验货地点（必填）"
            value={report.inspectionLocation ?? ""}
            disabled={disabled}
            onChange={(event) => onChange({ ...report, inspectionLocation: nullableText(event.target.value) })}
          />
          <InsetField
            label="颜色（必填）"
            value={report.color ?? ""}
            disabled={disabled}
            onChange={(event) => onChange({ ...report, color: nullableText(event.target.value) })}
          />
          <InsetField
            label="抽查数量（必填）"
            type="number"
            min="1"
            step="1"
            suffix="件"
            value={report.sampleQuantity?.toString() ?? ""}
            disabled={disabled}
            onChange={(event) => onChange({ ...report, sampleQuantity: nullableNumber(event.target.value) })}
          />
          <InsetField
            label="验货日期（必填）"
            type="date"
            value={report.inspectionDate ?? ""}
            disabled={disabled}
            onChange={(event) => onChange({ ...report, inspectionDate: event.target.value || null })}
          />
        </div>
      </Surface>}

      <Surface className="inspection-section inspection-measurements">
        <div className="section-title">
          <div>
            <h2>尺寸核验</h2>
            <p>单位厘米，精确到 0.1；目前没有标准尺码库，请同时填写实测值与人工核对后的偏差。</p>
          </div>
          {!disabled ? <Button onClick={() => {
            const sample = newSample(report.sizeSamples.length + 1);
            onChange({ ...report, sizeSamples: [...report.sizeSamples, sample] });
            setSelectedSampleId(sample.sampleId);
          }}>新增抽检件</Button> : null}
        </div>
        <div className="inspection-sample-tabs" role="tablist" aria-label="尺码和抽检件">
          {report.sizeSamples.map((sample) => (
            <button
              className={sample.sampleId === selected?.sampleId ? "is-active" : ""}
              type="button"
              role="tab"
              aria-selected={sample.sampleId === selected?.sampleId}
              key={sample.sampleId}
              onClick={() => setSelectedSampleId(sample.sampleId)}
            >
              <strong>{sample.sizeLabel}</strong><small>{sample.sampleLabel}</small>
            </button>
          ))}
        </div>
        {selected ? (
          <div className="inspection-sample-editor">
            <div className="inspection-sample-meta">
              <InsetField
                label="尺码"
                value={selected.sizeLabel}
                disabled={disabled}
                onChange={(event) => updateSample({ ...selected, sizeLabel: event.target.value })}
              />
              <InsetField
                label="抽检件名称"
                value={selected.sampleLabel}
                disabled={disabled}
                onChange={(event) => updateSample({ ...selected, sampleLabel: event.target.value })}
              />
              {!disabled && report.sizeSamples.length > 1 ? (
                <Button onClick={() => onChange({
                  ...report,
                  sizeSamples: report.sizeSamples.filter((sample) => sample.sampleId !== selected.sampleId),
                })}>移除此件</Button>
              ) : null}
            </div>
            <div className="inspection-measurement-table" role="table" aria-label={`${selected.sizeLabel} ${selected.sampleLabel} 尺寸核验`}>
              <div className="inspection-measurement-row inspection-measurement-row--head" role="row">
                <span>部位</span><span>实测 cm</span><span>偏差 cm</span><span>不适用</span>
              </div>
              {selected.measurements.map((measurement, index) => (
                <div className="inspection-measurement-row" role="row" key={`${measurement.partName}-${index}`}>
                  <input
                    aria-label={`第 ${index + 1} 行部位`}
                    value={measurement.partName}
                    disabled={disabled || DEFAULT_MEASUREMENT_PARTS.includes(measurement.partName as typeof DEFAULT_MEASUREMENT_PARTS[number])}
                    onChange={(event) => updateSample({
                      ...selected,
                      measurements: selected.measurements.map((item, itemIndex) => itemIndex === index ? { ...item, partName: event.target.value } : item),
                    })}
                  />
                  <input
                    aria-label={`${measurement.partName}实测值`}
                    type="number"
                    inputMode="decimal"
                    min="0"
                    step="0.1"
                    value={measurement.actualCm ?? ""}
                    disabled={disabled || measurement.notApplicable}
                    onChange={(event) => updateSample({
                      ...selected,
                      measurements: selected.measurements.map((item, itemIndex) => itemIndex === index ? { ...item, actualCm: nullableNumber(event.target.value) } : item),
                    })}
                  />
                  <input
                    aria-label={`${measurement.partName}偏差值`}
                    type="number"
                    inputMode="decimal"
                    step="0.1"
                    placeholder="±0.0"
                    value={measurement.deviationCm ?? ""}
                    disabled={disabled || measurement.notApplicable}
                    onChange={(event) => updateSample({
                      ...selected,
                      measurements: selected.measurements.map((item, itemIndex) => itemIndex === index ? { ...item, deviationCm: nullableNumber(event.target.value) } : item),
                    })}
                  />
                  <label className="inspection-na">
                    <input
                      type="checkbox"
                      checked={measurement.notApplicable}
                      disabled={disabled}
                      onChange={(event) => updateSample({
                        ...selected,
                        measurements: selected.measurements.map((item, itemIndex) => itemIndex === index ? {
                          ...item,
                          notApplicable: event.target.checked,
                          actualCm: event.target.checked ? null : item.actualCm,
                          deviationCm: event.target.checked ? null : item.deviationCm,
                        } : item),
                      })}
                    /><span>—</span>
                  </label>
                </div>
              ))}
            </div>
            {!disabled ? (
              <Button onClick={() => updateSample({
                ...selected,
                measurements: [...selected.measurements, {
                  partName: `其他部位 ${selected.measurements.length - DEFAULT_MEASUREMENT_PARTS.length + 1}`,
                  actualCm: null,
                  deviationCm: null,
                  notApplicable: false,
                }],
              })}>新增其他部位</Button>
            ) : null}
          </div>
        ) : null}
      </Surface>
    </>
  );
}

function CheckSelect({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: CheckResult | null;
  disabled: boolean;
  onChange: (value: CheckResult | null) => void;
}) {
  return (
    <label className="dx-field inspection-check-row">
      <span>{label}</span>
      <span className="dx-field__control">
        <select value={value ?? ""} disabled={disabled} onChange={(event) => onChange(event.target.value ? event.target.value as CheckResult : null)}>
          <option value="">请选择</option>
          <option value="pass">合格</option>
          <option value="fail">不合格</option>
        </select>
      </span>
    </label>
  );
}

export function InspectionReportStepTwo({ report, disabled, onChange }: { report: InspectionReportDraft; disabled: boolean; onChange: ReportChange }) {
  const documentOptions: Array<[keyof Omit<InspectionReportDraft["documentChecks"], "exceptionReason">, string]> = [
    ["confirmationSample", "确认样"],
    ["approvalCard", "批版卡"],
    ["supplierSelfInspection", "供应商自检报告"],
    ["bulkFabricInspection", "大货面料检测单"],
  ];
  return (
    <>
      <Surface className="inspection-section">
        <div className="section-title"><div><h2>资料核对</h2><p>勾选已核对且可接受的资料；缺失或不接受时说明原因。</p></div><StatusBadge tone="info">步骤 2/3</StatusBadge></div>
        <div className="inspection-document-checks">
          {documentOptions.map(([field, label]) => (
            <label key={field}><input type="checkbox" checked={report.documentChecks[field]} disabled={disabled} onChange={(event) => onChange({
              ...report,
              documentChecks: { ...report.documentChecks, [field]: event.target.checked },
            })} /><span>{label}</span></label>
          ))}
        </div>
        <InsetField
          label="未核对 / 不接受原因"
          value={report.documentChecks.exceptionReason ?? ""}
          disabled={disabled}
          placeholder="资料齐全时可不填"
          onChange={(event) => onChange({ ...report, documentChecks: { ...report.documentChecks, exceptionReason: nullableText(event.target.value) } })}
        />
        <div className="qc-form-grid inspection-select-grid">
          <label className="dx-field"><span>大货面料与颜色匹配</span><span className="dx-field__control"><select value={report.fabricMatch ?? ""} disabled={disabled} onChange={(event) => onChange({ ...report, fabricMatch: event.target.value ? event.target.value as InspectionReportDraft["fabricMatch"] : null })}><option value="">请选择</option><option value="match">匹配</option><option value="mismatch">不匹配</option></select></span></label>
          <label className="dx-field"><span>版型判定</span><span className="dx-field__control"><select value={report.fitDecision ?? ""} disabled={disabled} onChange={(event) => onChange({ ...report, fitDecision: event.target.value ? event.target.value as InspectionReportDraft["fitDecision"] : null })}><option value="">请选择</option><option value="accepted">接受</option><option value="recheck_after_rework">返工后复查</option><option value="rejected">不接受</option></select></span></label>
          <label className="dx-field"><span>工厂准备执行</span><span className="dx-field__control"><select value={report.factoryPreparation ?? ""} disabled={disabled} onChange={(event) => onChange({ ...report, factoryPreparation: event.target.value ? event.target.value as InspectionReportDraft["factoryPreparation"] : null })}><option value="">请选择</option><option value="strict">严格</option><option value="not_done">未执行</option><option value="perfunctory">敷衍</option></select></span></label>
        </div>
        {report.fabricMatch === "mismatch" ? <InsetField label="面料 / 颜色不匹配原因（必填）" value={report.fabricMismatchReason ?? ""} disabled={disabled} onChange={(event) => onChange({ ...report, fabricMismatchReason: nullableText(event.target.value) })} /> : null}
      </Surface>
      <Surface className="inspection-section">
        <div className="section-title"><div><h2>面辅料查验</h2><p>逐项记录查验结论。</p></div></div>
        <div className="inspection-material-grid">
          <CheckSelect label="面料物理性能（干擦 / 湿擦 / 色差 / 纰裂 / 车爆孔 / 异味）" value={report.materialChecks.physicalPerformance} disabled={disabled} onChange={(physicalPerformance) => onChange({ ...report, materialChecks: { ...report.materialChecks, physicalPerformance } })} />
          <CheckSelect label="洗水测试（起毛球 / 掉毛 / 裸色 / 掉色 / 互染 / 印绣花 / 缩率）" value={report.materialChecks.washTest} disabled={disabled} onChange={(washTest) => onChange({ ...report, materialChecks: { ...report.materialChecks, washTest } })} />
          <CheckSelect label="产品标识（主唛 / 洗水唛 / 吊牌 / 成分）" value={report.materialChecks.productMarking} disabled={disabled} onChange={(productMarking) => onChange({ ...report, materialChecks: { ...report.materialChecks, productMarking } })} />
        </div>
      </Surface>
    </>
  );
}

export function InspectionReportStepThree({ report, disabled, onChange }: { report: InspectionReportDraft; disabled: boolean; onChange: ReportChange }) {
  const totalMajor = report.issues.reduce((sum, issue) => sum + issue.majorCount, 0);
  const totalMinor = report.issues.reduce((sum, issue) => sum + issue.minorCount, 0);
  return (
    <>
      <Surface className="inspection-section">
        <div className="section-title"><div><h2>验货问题总结</h2><p>每类问题单独记录，严重与轻微数量自动合计。</p></div><StatusBadge tone="info">步骤 3/3</StatusBadge></div>
        <div className="inspection-issues">
          {report.issues.map((issue, index) => (
            <article key={issue.issueId} className="inspection-issue-card">
              <header><strong>问题 {index + 1}</strong>{!disabled && report.issues.length > 1 ? <Button onClick={() => onChange({ ...report, issues: report.issues.filter((item) => item.issueId !== issue.issueId) })}>移除</Button> : null}</header>
              <div className="qc-form-grid">
                <InsetField label="问题分类 / 部位" value={issue.category ?? ""} disabled={disabled} onChange={(event) => onChange({ ...report, issues: report.issues.map((item) => item.issueId === issue.issueId ? { ...item, category: nullableText(event.target.value) } : item) })} />
                <InsetField label="主要问题描述" value={issue.description ?? ""} disabled={disabled} onChange={(event) => onChange({ ...report, issues: report.issues.map((item) => item.issueId === issue.issueId ? { ...item, description: nullableText(event.target.value) } : item) })} />
                <InsetField label="严重" type="number" min="0" step="1" value={issue.majorCount.toString()} disabled={disabled} suffix="件" onChange={(event) => onChange({ ...report, issues: report.issues.map((item) => item.issueId === issue.issueId ? { ...item, majorCount: Math.max(0, Number(event.target.value) || 0) } : item) })} />
                <InsetField label="轻微" type="number" min="0" step="1" value={issue.minorCount.toString()} disabled={disabled} suffix="件" onChange={(event) => onChange({ ...report, issues: report.issues.map((item) => item.issueId === issue.issueId ? { ...item, minorCount: Math.max(0, Number(event.target.value) || 0) } : item) })} />
              </div>
            </article>
          ))}
        </div>
        <div className="inspection-issue-total"><span>合计</span><strong>严重 {totalMajor} 件</strong><strong>轻微 {totalMinor} 件</strong></div>
        {!disabled ? <Button onClick={() => onChange({ ...report, issues: [...report.issues, { issueId: createClientRequestId(), category: null, description: null, majorCount: 0, minorCount: 0 }] })}>新增问题</Button> : null}
      </Surface>
      <Surface className="inspection-section">
        <div className="section-title"><div><h2>结论与签名</h2><p>验货结果固定为返工；查货人由系统记录当前操作人。</p></div><StatusBadge tone="warning">返工</StatusBadge></div>
        <div className="qc-form-grid">
          <label className="dx-field qc-wide"><span>不合格主因（必填）</span><span className="dx-field__control qc-textarea-control"><textarea rows={3} value={report.nonconformanceCause ?? ""} disabled={disabled} onChange={(event) => onChange({ ...report, nonconformanceCause: nullableText(event.target.value) })} /></span></label>
          <label className="dx-field qc-wide"><span>批复意见（可补充）</span><span className="dx-field__control qc-textarea-control"><textarea rows={2} value={report.approvalOpinion ?? ""} disabled={disabled} onChange={(event) => onChange({ ...report, approvalOpinion: nullableText(event.target.value) })} /></span></label>
          <InsetField label="供应商签名（可补充）" value={report.supplierSignatoryName ?? ""} disabled={disabled} onChange={(event) => onChange({ ...report, supplierSignatoryName: nullableText(event.target.value) })} />
          <InsetField label="供应商签名日期（可补充）" type="date" value={report.supplierSignedOn ?? ""} disabled={disabled} onChange={(event) => onChange({ ...report, supplierSignedOn: event.target.value || null })} />
        </div>
      </Surface>
    </>
  );
}
