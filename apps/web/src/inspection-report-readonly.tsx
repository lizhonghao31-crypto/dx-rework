import type { InspectionReportDraft } from "@dx-rework/contracts";

import "./rework-detail-compact.css";

const labels = {
  stage: { midline: "中查", final: "整查", warehouse: "仓检", reinspection: "复检" },
  check: { pass: "合格", fail: "不合格" },
  fabric: { match: "匹配", mismatch: "不匹配" },
  fit: { accepted: "接受", recheck_after_rework: "返工后复查", rejected: "不接受" },
  preparation: { strict: "严格", not_done: "未执行", perfunctory: "敷衍" },
} as const;

const valueOrDash = (value: string | number | null | undefined): string => value === null || value === undefined || value === "" ? "—" : String(value);

export function InspectionReportReadonly({ report }: { report: InspectionReportDraft }) {
  const documents = [
    ["确认样", report.documentChecks.confirmationSample],
    ["批版卡", report.documentChecks.approvalCard],
    ["供应商自检报告", report.documentChecks.supplierSelfInspection],
    ["大货面料检测单", report.documentChecks.bulkFabricInspection],
  ] as const;
  const totalMajor = report.issues.reduce((sum, issue) => sum + issue.majorCount, 0);
  const totalMinor = report.issues.reduce((sum, issue) => sum + issue.minorCount, 0);
  const summary = [
    report.inspectionStage ? labels.stage[report.inspectionStage] : null,
    report.inspectionLocation || null,
    report.color ? `颜色 ${report.color}` : null,
    report.sampleQuantity ? `抽查 ${report.sampleQuantity} 件` : null,
  ].filter((item): item is string => Boolean(item)).join(" · ") || "节点 01 验货记录";

  return (
    <details className="inspection-readonly" aria-label="数字化验货报告">
      <summary className="inspection-readonly__summary">
        <span className="inspection-readonly__summary-copy">
          <strong>验货报告</strong>
          <small>{summary}</small>
        </span>
        <span className="inspection-readonly__summary-toggle" aria-hidden="true">⌄</span>
      </summary>
      <div className="inspection-readonly__content">
        <div className="inspection-readonly__heading">
          <div><h2>详细质检记录</h2><p>节点 01 提交的数字化质检记录</p></div>
          <span>结论：返工</span>
        </div>
        <dl className="inspection-readonly__facts">
          <div><dt>验货阶段</dt><dd>{report.inspectionStage ? labels.stage[report.inspectionStage] : "—"}</dd></div>
          <div><dt>验货地点</dt><dd>{valueOrDash(report.inspectionLocation)}</dd></div>
          <div><dt>颜色</dt><dd>{valueOrDash(report.color)}</dd></div>
          <div><dt>抽查数量</dt><dd>{report.sampleQuantity ? `${report.sampleQuantity} 件` : "—"}</dd></div>
          <div><dt>验货日期</dt><dd>{valueOrDash(report.inspectionDate)}</dd></div>
          <div><dt>尺寸精度</dt><dd>厘米 · 0.1</dd></div>
        </dl>

        <div className="inspection-readonly__block">
          <h3>尺寸核验</h3>
          <div className="inspection-readonly__samples">
            {report.sizeSamples.map((sample) => (
              <details key={sample.sampleId}>
                <summary><strong>{sample.sizeLabel}</strong><span>{sample.sampleLabel}</span></summary>
                <div className="inspection-readonly__measurement-head"><span>部位</span><span>实测 cm</span><span>偏差 cm</span></div>
                {sample.measurements.map((measurement) => (
                  <div className="inspection-readonly__measurement" key={measurement.partName}>
                    <strong>{measurement.partName}</strong>
                    <span>{measurement.notApplicable ? "—" : valueOrDash(measurement.actualCm)}</span>
                    <span>{measurement.notApplicable ? "—" : valueOrDash(measurement.deviationCm)}</span>
                  </div>
                ))}
              </details>
            ))}
          </div>
        </div>

        <div className="inspection-readonly__columns">
          <div className="inspection-readonly__block">
            <h3>资料核对</h3>
            <ul>{documents.map(([label, checked]) => <li key={label}><span>{label}</span><strong>{checked ? "已核对" : "未核对"}</strong></li>)}</ul>
            {report.documentChecks.exceptionReason ? <p>例外：{report.documentChecks.exceptionReason}</p> : null}
            <p>面料与颜色：{report.fabricMatch ? labels.fabric[report.fabricMatch] : "—"}</p>
            {report.fabricMismatchReason ? <p>不匹配原因：{report.fabricMismatchReason}</p> : null}
            <p>版型：{report.fitDecision ? labels.fit[report.fitDecision] : "—"}</p>
            <p>工厂准备：{report.factoryPreparation ? labels.preparation[report.factoryPreparation] : "—"}</p>
          </div>
          <div className="inspection-readonly__block">
            <h3>面辅料查验</h3>
            <ul>
              <li><span>面料物理性能</span><strong>{report.materialChecks.physicalPerformance ? labels.check[report.materialChecks.physicalPerformance] : "—"}</strong></li>
              <li><span>洗水测试</span><strong>{report.materialChecks.washTest ? labels.check[report.materialChecks.washTest] : "—"}</strong></li>
              <li><span>产品标识</span><strong>{report.materialChecks.productMarking ? labels.check[report.materialChecks.productMarking] : "—"}</strong></li>
            </ul>
          </div>
        </div>

        <div className="inspection-readonly__block">
          <div className="inspection-readonly__issue-heading"><h3>问题总结</h3><span>严重 {totalMajor} · 轻微 {totalMinor}</span></div>
          <div className="inspection-readonly__issues">
            {report.issues.map((issue) => (
              <article key={issue.issueId}>
                <strong>{valueOrDash(issue.category)}</strong>
                <p>{valueOrDash(issue.description)}</p>
                <small>严重 {issue.majorCount} 件 · 轻微 {issue.minorCount} 件</small>
              </article>
            ))}
          </div>
          <p><strong>不合格主因：</strong>{valueOrDash(report.nonconformanceCause)}</p>
          {report.approvalOpinion ? <p><strong>批复意见：</strong>{report.approvalOpinion}</p> : null}
          {(report.supplierSignatoryName || report.supplierSignedOn) ? <p><strong>供应商签名：</strong>{valueOrDash(report.supplierSignatoryName)} · {valueOrDash(report.supplierSignedOn)}</p> : null}
        </div>
      </div>
    </details>
  );
}
