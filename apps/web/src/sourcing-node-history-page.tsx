import { SourcingOrderPhotos } from "./sourcing-order-photos.js";
import { SourcingOrderDateFacts } from "./sourcing-order-date-facts.js";
import { useEffect, useState } from "react";
import { SourcingNodeHistorySchema, type SourcingNodeHistory, type SourcingHistoryNode, type SourcingAttachment } from "@dx-rework/contracts";
import { formatBusinessCurrency, formatBusinessDecimal } from "@dx-rework/contracts/business-display";
import { DecisionSummary, KeyFacts, ResponsiveFactsTable, Surface, WorkflowRail } from "@dx-rework/ui";
import { Header } from "./components.js";
import { ImageViewer } from "./image-viewer.js";
import { createWebUrls } from "../url-contract.js";
import { historicalSourcingPrice, sourcingLinePricing } from "./sourcing-price-presentation.js";

const { apiUrl, pageUrl } = createWebUrls(import.meta.env.BASE_URL);
const nodes = [
  ["created", "跟单创建订单"], ["ie_quote", "IE 给价"], ["management", "调价与选厂"],
  ["owner", "最终审批"], ["finance", "财务核对"],
] as const;
const labels = Object.fromEntries(nodes);
const dateTime = (value: string) => new Date(value).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
const pictureUrl = (id: string) => apiUrl(`tools/attachments/${id}/download?mode=preview`);
const amountDifference = (left?: string, right?: string): string => {
  if (!left || !right) return "—";
  const cents = (value: string) => { const [whole, fraction = ""] = value.split("."); return BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, "0")); };
  const difference = cents(left) - cents(right);
  const absolute = difference < 0n ? -difference : difference;
  return `${difference < 0n ? "−" : difference > 0n ? "+" : ""}${formatBusinessCurrency(`${absolute / 100n}.${String(absolute % 100n).padStart(2, "0")}`)}`;
};
const field = (label: string, value: string | null | undefined) => <label key={label}><span>{label}</span><input readOnly value={value || "历史未记录"} /></label>;

export function SourcingNodeHistoryPage({ sourcingCaseId, node, returnTo }: {
  sourcingCaseId: string; node: SourcingHistoryNode; returnTo: string | null;
}) {
  const [history, setHistory] = useState<SourcingNodeHistory | null>(null);
  const [error, setError] = useState("");
  const [selectedImage, setSelectedImage] = useState<SourcingAttachment | null>(null);
  const entryId = new URLSearchParams(window.location.search).get("entryId");
  useEffect(() => {
    let cancelled = false;
    setHistory(null); setError("");
    const query = entryId ? `?${new URLSearchParams({ entryId })}` : "";
    void fetch(apiUrl(`sourcing/cases/${sourcingCaseId}/history/${node}${query}`), { credentials: "include", cache: "no-store" })
      .then(async response => {
        if (!response.ok) throw new Error(response.status === 404 ? "该节点没有已提交的历史记录" : "历史页面加载失败，请返回重试");
        return SourcingNodeHistorySchema.parse(await response.json());
      }).then(value => { if (!cancelled) setHistory(value); })
      .catch((reason: unknown) => { if (!cancelled) setError(reason instanceof Error ? reason.message : "历史页面加载失败"); });
    return () => { cancelled = true; };
  }, [sourcingCaseId, node, entryId]);
  const href = (selected?: SourcingHistoryNode, version?: string) => {
    const query = new URLSearchParams();
    if (returnTo) query.set("returnTo", returnTo);
    if (selected) { query.set("node", selected); query.set("view", "node-history"); }
    if (version) query.set("entryId", version);
    return `${pageUrl(`ui/sourcing/orders/${sourcingCaseId}`)}?${query}`;
  };
  if (!history) return <div className="sourcing-workspace sourcing-order-detail" aria-busy={!error}>
    <p role="status">{error || "正在加载历史页面…"}</p>
    {error ? <div className="sourcing-history-navigation"><a className="dx-button dx-button--primary" href={href()}>返回当前节点</a></div> : null}
  </div>;
  return <SourcingNodeHistoryView history={history} currentHref={href()} nodeHref={href}
    onImage={setSelectedImage}>
    {selectedImage ? <div className="rework-image-modal"><section className="rework-image-modal__content" role="dialog" aria-modal="true" aria-label={selectedImage.filename}><div className="rework-image-modal__heading"><strong>{selectedImage.filename}</strong><button type="button" onClick={() => setSelectedImage(null)}>关闭</button></div><ImageViewer src={pictureUrl(selectedImage.attachmentId)} alt={selectedImage.filename} /></section></div> : null}
  </SourcingNodeHistoryView>;
}

// Local read-only page: no submission callbacks, uploaders or mutable draft state.
export function SourcingNodeHistoryView({ history, currentHref, nodeHref, onImage, children }: {
  history: SourcingNodeHistory; currentHref: string; nodeHref: (node: SourcingHistoryNode, entryId?: string) => string;
  onImage: (image: SourcingAttachment) => void; children?: React.ReactNode;
}) {
  const { item, node, entry, versions, attachments, notices, relatedEntries } = history;
  const index = nodes.findIndex(([key]) => key === node);
  const prices = node === "ie_quote" ? item.ieQuote : item.decision;
  const cutting = item.decision?.cuttingProcess === "in_house" ? "本厂裁" : item.decision?.cuttingProcess === "outsourced" ? "外厂裁" : item.decision?.cuttingProcessOther;
  return <div className="sourcing-workspace sourcing-order-detail sourcing-node-history sourcing-module-layout" data-legacy-ui="sourcing">
    <Header iconRoute="/ui/sourcing/pending" title={item.styleNo} subtitle={`${item.gender ?? "历史未维护"} · ${item.styleName ?? "历史未维护"}`} badge="历史节点 · 只读" badgePlacement="subtitle" />
    <div className="sourcing-history-navigation">
      <div><h2>{labels[node]}</h2><span>{dateTime(entry.handledAt)} · {entry.handledBy}</span></div>
      <a className="dx-button dx-button--primary" href={currentHref}>返回当前节点</a>
      {versions.length > 1 ? <label>历史版本<select value={entry.entryId} onChange={event => { window.location.href = nodeHref(node, event.target.value); }}>
        {versions.map(version => <option key={version.entryId} value={version.entryId}>V{version.version} · {dateTime(version.handledAt)}</option>)}
      </select></label> : null}
    </div>
    {notices.map(notice => <p key={notice} role="status">{notice}</p>)}
    <div className="sourcing-detail-layout sourcing-reference-layout">
      <KeyFacts className="sourcing-key-facts" aria-label="历史节点订单核心信息">
        <div><dt>跟单</dt><dd>{item.merchandiserName ?? "历史未维护"}</dd></div>
        <div className="sourcing-key-facts__factory"><dt>当时方案工厂</dt><dd>{item.decision?.supplierName ?? "当时未选厂"}</dd></div>
        <div><dt>订单总数量</dt><dd>{formatBusinessDecimal(item.orderQuantity)} 件</dd></div>
        <div><dt>当时方案生产总额</dt><dd>{item.decision ? formatBusinessCurrency(item.decision.totalAmount) : "—"}</dd></div>
        <div><dt>IE 总额</dt><dd>{item.ieQuote ? formatBusinessCurrency(item.ieQuote.totalAmount) : "—"}</dd></div>
        <div><dt>较 IE 总额变化</dt><dd>{amountDifference(item.decision?.totalAmount, item.ieQuote?.totalAmount)}</dd></div>
        <div className="sourcing-key-facts__date"><dt>预计裁片发出</dt><dd>{item.estimatedCutPieceSendDate ?? "历史未维护"}</dd></div>
        <SourcingOrderDateFacts item={item} historical />
      </KeyFacts>
      <div className="sourcing-supporting-overview">
        <SourcingOrderPhotos attachments={attachments} previewUrl={image => pictureUrl(image.attachmentId)} onPreview={onImage} />
        <section className="sourcing-workflow-section" aria-label="订单流程">
              <div className="sourcing-order-panel-heading"><h2>订单流程</h2><span>正在回看：{labels[node]}</span></div>

              <div className="sourcing-workflow-content"><WorkflowRail className="sourcing-workflow-rail">
                {nodes.map(([key, label], position) => position <= index ? <a key={key} className={`sourcing-workflow-step is-${key === node ? "current" : "completed"}`} href={nodeHref(key)} aria-current={key === node ? "page" : undefined}><b>{position + 1}</b><span><strong>{label}</strong></span><em>{key === node ? "正在回看" : "查看历史"}</em></a> : <div key={key} className="sourcing-workflow-step is-future"><b>{position + 1}</b><span><strong>{label}</strong></span><em>后续节点</em></div>)}
              </WorkflowRail></div>
            </section>
      </div>
      <div className="order-layout-workspace">
        <div className={`order-layout-main${node === "owner" ? " sourcing-owner-workspace" : ""}`}>{node === "owner" ? <header className="sourcing-order-workspace-heading"><h2>审批资料</h2><p>此处展示该次审批时保存的资料。</p></header> : null}

          {item.decision ? <DecisionSummary title={node === "owner" ? "审批摘要" : "选厂摘要"}><p>当时方案加工厂：<strong>{item.decision.supplierName}</strong>；本次方案数量：{formatBusinessDecimal(item.decision.quantity)} 件；生产总额：<strong>{formatBusinessCurrency(item.decision.totalAmount)}</strong>。</p><p>工艺及承包范围：{item.processes.join("、") || "历史未填写"}；裁床工序：{cutting || "历史未填写"}。</p>{item.decision.decisionReason ? <p>生产管理说明：{item.decision.decisionReason}</p> : null}</DecisionSummary> : null}
          <div className="order-layout-line-items" tabIndex={0} role="group" aria-label="款式明细横向滚动">
            <ResponsiveFactsTable caption="款式明细" mobileLayout="compact" rows={item.lineItems} rowKey={line => line.position}
            totals={{ style: "合计", quantity: `${formatBusinessDecimal(item.orderQuantity)} 件`, amount: prices ? formatBusinessCurrency(prices.totalAmount) : "—" }}
            columns={[
              { key: "style", label: "款号", mobileHeading: true, render: line => <>{line.styleNo}{line.alternateStyleNo && line.alternateStyleNo !== line.styleNo ? <small>代用：{line.alternateStyleNo}</small> : null}</> },
              { key: "color", label: "颜色", mobileHeading: true, render: line => line.color ?? "历史未维护" },
              { key: "quantity", label: "数量", render: line => `${formatBusinessDecimal(line.quantity)} 件` },
              ...("daxingUnitPrice" in item ? [{ key: "budget", label: "预算价", render: () => formatBusinessCurrency(item.daxingUnitPrice!) }] : []),
              ...(node !== "created" ? [{ key: "ie", label: "IE 单价", render: (line: SourcingNodeHistory["item"]["lineItems"][number]) => { const price = sourcingLinePricing(item.ieQuote, line.position, item.lineItems.length); return price ? historicalSourcingPrice(price.unitPrice) : "—"; } }] : []),
              ...(index >= 2 ? [{ key: "production", label: "生产单价", render: (line: SourcingNodeHistory["item"]["lineItems"][number]) => { const price = sourcingLinePricing(item.decision, line.position, item.lineItems.length); return price ? historicalSourcingPrice(price.unitPrice) : "—"; } }] : []),
              { key: "amount", label: "本款金额", render: line => { const price = sourcingLinePricing(prices, line.position, item.lineItems.length); return price?.totalAmount ? formatBusinessCurrency(price.totalAmount) : "—"; } },
            ]} />
          </div>
          <Surface className="rework-detail-node-preview">
            <h2>{labels[node]}</h2>
            <div className="sourcing-form-grid sourcing-history-fields">
              {node === "created" ? <>{field("性别", item.gender)}{field("款式类别", item.styleName)}{field("预计裁片发出", item.estimatedCutPieceSendDate)}{field("要求交货日期", item.deliveryDate)}{field("创建说明", entry.reason)}</> : null}
              {node === "ie_quote" || node === "management" ? <>
                <div className="sourcing-line-price-table sourcing-form-wide" role="table" aria-label={`${labels[node]}逐款价格（只读）`}>{item.lineItems.map(line => {
                  const price = sourcingLinePricing(prices, line.position, item.lineItems.length);
                  return <label className="sourcing-line-price-row" key={line.position}><span>{line.styleNo} · {line.color}<small>{formatBusinessDecimal(line.quantity)} 件</small></span><input aria-label={`${line.styleNo} ${node === "ie_quote" ? "IE" : "生产"}单价（只读）`} readOnly value={price ? historicalSourcingPrice(price.unitPrice) : "历史未记录"} /><strong>{price?.totalAmount ? formatBusinessCurrency(price.totalAmount) : "—"}</strong></label>;
                })}</div>
                {field("逐款汇总", prices ? formatBusinessCurrency(prices.totalAmount) : null)}
                <label className="sourcing-form-wide"><span>{node === "ie_quote" ? "价格说明" : "选厂／调价说明"}</span><textarea readOnly value={entry.reason} /></label>
              </> : null}
              {node === "owner" ? <>{field("审批结果", entry.decision === "approved" ? "同意" : "驳回")}<label className="sourcing-form-wide"><span>审批说明</span><textarea readOnly value={entry.reason} /></label></> : null}
              {node === "finance" ? <>{field("对应合同", history.contractReference)}{field("批准加工厂", item.decision?.supplierName)}{field("批准数量", `${formatBusinessDecimal(item.orderQuantity)} 件`)}{field("批准总额", item.decision ? formatBusinessCurrency(item.decision.totalAmount) : null)}{field("核对结果", entry.result === "match" ? "确认与合同一致" : "发现不一致")}{entry.differenceFields.length ? field("不一致项目", entry.differenceFields.map(value => ({ supplier: "加工厂", unit_price: "单价", quantity: "数量", total_amount: "总额" })[value]).join("、")) : null}<label className="sourcing-form-wide"><span>核对说明</span><textarea readOnly value={entry.reason} /></label></> : null}
            </div>
          </Surface>

        </div>

      </div>
    </div>
    {relatedEntries.length ? <section className="sourcing-history-related" aria-label="订单相关处理记录">
      <h2>{node === "management" ? "订单转厂记录" : node === "finance" ? "合同与差异处理记录" : "款号修订记录"}</h2>
      <p>以下为该订单的相关记录，时间范围独立于上方选定的节点版本。</p>
      {relatedEntries.map(record => <article key={record.entryId}>
        <div><strong>{record.kind === "factory_change_request" ? "转厂申请" : record.kind === "factory_change_verification" ? "转厂审核" : record.kind === "contract" ? "合同" : record.kind === "exception_verification" ? "差异处理" : "款号修订"}
          {record.decision ? ` · ${record.decision === "approved" ? "通过" : "驳回"}` : ""}</strong><span>{dateTime(record.handledAt)} · {record.handledBy}</span></div>
        {record.supplierName ? <p>申请加工厂：{record.supplierName}；单价：{record.unitPrice ? historicalSourcingPrice(record.unitPrice) : "—"}；数量：{record.quantity ? formatBusinessDecimal(record.quantity) : "—"}；总额：{record.totalAmount ? formatBusinessCurrency(record.totalAmount) : "—"}</p> : null}
        {record.contractReference ? <p>合同编号：{record.contractReference}</p> : null}
        {record.resolution ? <p>{record.resolution === "close" ? "确认差异并闭环" : "退回财务重核"}</p> : null}
        <p>{record.reason}</p>
      </article>)}
    </section> : null}
    {children}
  </div>;
}
