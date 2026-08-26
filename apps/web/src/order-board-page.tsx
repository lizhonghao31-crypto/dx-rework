import { KpiInstrument, StatusBadge, Surface } from "@dx-rework/ui";
import { useEffect, useMemo, useState } from "react";

import { createWebUrls } from "../url-contract.js";
import { verifySession } from "./auth.js";
import { useDebouncedValue } from "./use-debounced-value.js";
import "./order-board-page.css";

const { apiUrl, pageUrl } = createWebUrls(import.meta.env.BASE_URL);

type ReworkStatus = "draft" | "active" | "completed" | null;
type BoardRow = Readonly<{
  receivingBatchId: string;
  styleNo: string;
  documentQuantity: number;
  actualQuantity: number;
  defectiveQuantity: number;
  differenceQuantity: number;
  receiptCount: number;
  lastReceivedAt: string;
  lastReceiverName: string;
  reworkOrderId: string | null;
  reworkStatus: ReworkStatus;
  version: number;
  rootMutable: boolean;
}>;

type BoardResult = Readonly<{
  date: string;
  kpis: Readonly<{
    orderCount: number;
    receivedQuantity: number;
    abnormalOrderCount: number;
    differenceQuantity: number;
    differenceRate: number;
  }>;
  rows: readonly BoardRow[];
}>;

const localDate = (): string => {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const dateTime = (value: string): string => new Intl.DateTimeFormat("zh-CN", {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
}).format(new Date(value));

const reworkLabel = (status: ReworkStatus): string => {
  if (status === "draft") return "继续填写";
  if (status === "active") return "正在返工";
  if (status === "completed") return "返工结束";
  return "发起返工";
};

const responseError = async (response: Response, fallback: string): Promise<string> => {
  const body = await response.json().catch(() => null) as Readonly<{
    message?: string;
    error?: Readonly<{ message?: string }>;
  }> | null;
  return body?.error?.message ?? body?.message ?? fallback;
};

export function OrderBoardPage() {
  const [date, setDate] = useState(localDate);
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebouncedValue(query, 180);
  const [data, setData] = useState<BoardResult | null>(null);
  const [message, setMessage] = useState("正在加载订单看板…");
  const [canReceive, setCanReceive] = useState(false);
  const [canInitiate, setCanInitiate] = useState(false);
  const [isRoot, setIsRoot] = useState(false);
  const [refreshToken, setRefreshToken] = useState(0);
  const [editing, setEditing] = useState<BoardRow | null>(null);
  const [deleting, setDeleting] = useState<BoardRow | null>(null);
  const [editStyleNo, setEditStyleNo] = useState("");
  const [editDocumentQuantity, setEditDocumentQuantity] = useState("");
  const [editActualQuantity, setEditActualQuantity] = useState("");
  const [editDefectiveQuantity, setEditDefectiveQuantity] = useState("");
  const [mutationBusy, setMutationBusy] = useState(false);
  const [mutationMessage, setMutationMessage] = useState("");

  useEffect(() => {
    let active = true;
    void verifySession()
      .then((session) => {
        if (!active || session === "denied" || session.status !== "authorized") return;
        const isRoot = session.user.isRoot === true;
        const roles = session.user.businessRoles ?? [];
        const capabilities = session.user.capabilities;
        const warehouseReceiver = roles.includes("warehouse_receiver")
          && capabilities.includes("receiving:create");
        const qualityControl = roles.includes("quality_control")
          && capabilities.includes("rework:initiate");
        setCanReceive(isRoot || warehouseReceiver);
        setCanInitiate(isRoot || roles.includes("owner_group") || qualityControl);
        setIsRoot(isRoot);
      })
      .catch(() => {
        if (!active) return;
        setCanReceive(false);
        setCanInitiate(false);
        setIsRoot(false);
      });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    const params = new URLSearchParams({ date });
    if (debouncedQuery.trim()) params.set("q", debouncedQuery.trim());
    void fetch(apiUrl(`receiving/board?${params.toString()}`), { credentials: "include", cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("订单看板加载失败");
        return response.json() as Promise<BoardResult>;
      })
      .then((body) => {
        if (!active) return;
        setData(body);
        setMessage(body.rows.length ? "" : "当天没有匹配的收货记录");
      })
      .catch(() => {
        if (!active) return;
        setMessage("订单看板加载失败，请刷新后重试");
      });
    return () => { active = false; };
  }, [date, debouncedQuery, refreshToken]);

  const kpis = useMemo(() => data?.kpis ?? {
    orderCount: 0,
    receivedQuantity: 0,
    abnormalOrderCount: 0,
    differenceQuantity: 0,
    differenceRate: 0,
  }, [data]);

  const reworkControl = (row: BoardRow, mobile: boolean) => {
    const className = `order-board-rework-link ${mobile ? "order-board-rework-link--mobile" : "order-board-rework-link--desktop"}`;
    const label = reworkLabel(row.reworkStatus);
    if (row.reworkStatus === null) {
      if (!canInitiate) return null;
      const params = new URLSearchParams({ styleNo: row.styleNo, receivingBatchId: row.receivingBatchId });
      return <a className={className} href={`${pageUrl("ui/qc/new")}?${params.toString()}`}>{label}</a>;
    }
    if (row.reworkOrderId && canInitiate) {
      return <a className={className} href={pageUrl(`ui/tasks/${row.reworkOrderId}`)}>{label}</a>;
    }
    return <span className={`${className} is-readonly`}>{label}</span>;
  };

  const openEdit = (row: BoardRow) => {
    setDeleting(null);
    setEditing(row);
    setEditStyleNo(row.styleNo);
    setEditDocumentQuantity(String(row.documentQuantity));
    setEditActualQuantity(String(row.actualQuantity));
    setEditDefectiveQuantity(String(row.defectiveQuantity));
    setMutationMessage("");
  };

  const rootControls = (row: BoardRow, mobile: boolean) => {
    if (!isRoot || !row.rootMutable) return null;
    return <div className={`order-board-root-actions order-board-root-actions--${mobile ? "mobile" : "desktop"}`}>
      <button type="button" onClick={() => openEdit(row)}>修改</button>
      <button type="button" className="is-danger" onClick={() => { setEditing(null); setDeleting(row); setMutationMessage(""); }}>删除</button>
    </div>;
  };

  const submitCorrection = async () => {
    if (!editing || mutationBusy) return;
    if (Number(editDefectiveQuantity) > Number(editActualQuantity)) {
      setMutationMessage("次品数量不能超过实际收货数量");
      return;
    }
    setMutationBusy(true);
    setMutationMessage("");
    try {
      const response = await fetch(apiUrl(`receiving/batches/${editing.receivingBatchId}`), {
        method: "PATCH",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedVersion: editing.version,
          styleNo: editStyleNo,
          documentQuantity: Number(editDocumentQuantity),
          actualQuantity: Number(editActualQuantity),
          defectiveQuantity: Number(editDefectiveQuantity),
        }),
      });
      if (!response.ok) throw new Error(await responseError(response, "收货订单修改失败"));
      setEditing(null);
      setRefreshToken((value) => value + 1);
      setMutationMessage("收货订单已修改");
    } catch (error) {
      setMutationMessage(error instanceof Error ? error.message : "收货订单修改失败");
    } finally {
      setMutationBusy(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleting || mutationBusy) return;
    setMutationBusy(true);
    setMutationMessage("");
    try {
      const response = await fetch(apiUrl(`receiving/batches/${deleting.receivingBatchId}`), {
        method: "DELETE",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedVersion: deleting.version }),
      });
      if (!response.ok) throw new Error(await responseError(response, "收货订单删除失败"));
      setDeleting(null);
      setRefreshToken((value) => value + 1);
      setMutationMessage("收货订单已删除");
    } catch (error) {
      setMutationMessage(error instanceof Error ? error.message : "收货订单删除失败");
    } finally {
      setMutationBusy(false);
    }
  };

  return <div className="order-board-page">
    <div className="order-board-heading">
      <div className="order-board-heading__title">
        <h1>订单看板</h1>
        <p>快速查看收货数量差异；少收订单默认置顶。</p>
      </div>
      <div className="order-board-filters">
        <label>日期<input type="date" value={date} onChange={(event) => setDate(event.target.value)} /></label>
        <label>款号<input type="search" placeholder="快速搜索款号" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
      </div>
      <div className="order-board-heading__action">
        {canReceive ? <a className="order-board-receiving-link" href={pageUrl("ui/receiving")}>＋ 仓库收货</a> : null}
      </div>
    </div>

    <div className="order-board-kpis">
      <KpiInstrument label="今日收货订单数" value={kpis.orderCount} detail={date} tone="info" />
      <KpiInstrument label="今日收货数量" value={`${kpis.receivedQuantity}件`} detail={`${date} · 实际收货`} tone="info" />
      <KpiInstrument label="异常订单数量" value={kpis.abnormalOrderCount} detail="累计收货与单据数量不一致" tone={kpis.abnormalOrderCount ? "warning" : "success"} />
      <KpiInstrument label="差异率" value={`${kpis.differenceRate}%`} detail={`绝对差异 ${kpis.differenceQuantity} 件`} tone={kpis.differenceRate ? "warning" : "success"} />
    </div>

    <div className="order-board-legend" aria-label="差异颜色说明">
      <span><i className="is-short" />少收</span>
      <span><i className="is-extra" />多收</span>
      <span><i className="is-even" />无差异</span>
    </div>

    <div className="order-board-list">
      {data?.rows.map((row) => {
        const tone = row.differenceQuantity < 0 ? "short" : row.differenceQuantity > 0 ? "extra" : "even";
        const signed = row.differenceQuantity > 0 ? `+${row.differenceQuantity}` : String(row.differenceQuantity);
        return <Surface className={`order-board-row is-${tone}`} key={row.receivingBatchId}>
          <div className="order-board-row__style">
            <span>款号</span>
            <div className="order-board-row__style-line">
              <strong>{row.styleNo}</strong>
              <StatusBadge tone={tone === "short" ? "danger" : tone === "extra" ? "info" : "success"}>
                {tone === "short" ? "少收" : tone === "extra" ? "多收" : "正常"}
              </StatusBadge>
              {reworkControl(row, false)}
              {rootControls(row, false)}
            </div>
          </div>
          <div><span>收货单</span><strong>{row.documentQuantity}件</strong></div>
          <div><span>实收</span><strong>{row.actualQuantity}件</strong></div>
          <div><span>次品</span><strong>{row.defectiveQuantity}件</strong></div>
          <div className="order-board-row__difference"><span>差异</span><strong>{signed}件</strong></div>
          <div><span>收货次数</span><strong>{row.receiptCount}次</strong></div>
          <div><span>最近收货</span><strong>{dateTime(row.lastReceivedAt)}</strong></div>
          <div><span>收货人</span><strong>{row.lastReceiverName}</strong></div>
          {rootControls(row, true)}
          {reworkControl(row, true)}
        </Surface>;
      })}
    </div>
    {message ? <p className="order-board-message" role="status">{message}</p> : null}
    {mutationMessage && !editing && !deleting ? <p className="order-board-mutation-message" role="status">{mutationMessage}</p> : null}

    {editing ? <div className="order-board-dialog-backdrop" role="presentation" onMouseDown={() => !mutationBusy && setEditing(null)}>
      <form className="order-board-dialog" role="dialog" aria-modal="true" aria-label="修改收货订单" onMouseDown={(event) => event.stopPropagation()} onSubmit={(event) => { event.preventDefault(); void submitCorrection(); }}>
        <h2>修改收货订单</h2>
        <p>修改后用于看板和后续返工；原始收货记录与图片继续保留。</p>
        <label>款号<input value={editStyleNo} maxLength={100} disabled={mutationBusy} onChange={(event) => setEditStyleNo(event.target.value)} /></label>
        <div className="order-board-dialog__quantity-grid">
          <label>收货单数量<input type="number" min="1" max="10000000" step="1" inputMode="numeric" value={editDocumentQuantity} disabled={mutationBusy} onChange={(event) => setEditDocumentQuantity(event.target.value)} /></label>
          <label>实际收货数量<input type="number" min="0" max="10000000" step="1" inputMode="numeric" value={editActualQuantity} disabled={mutationBusy} onChange={(event) => setEditActualQuantity(event.target.value)} /></label>
          <label>次品数量<input type="number" min="0" max="10000000" step="1" inputMode="numeric" value={editDefectiveQuantity} disabled={mutationBusy} onChange={(event) => setEditDefectiveQuantity(event.target.value)} /></label>
        </div>
        {mutationMessage ? <p className="order-board-dialog__error" role="alert">{mutationMessage}</p> : null}
        <div className="order-board-dialog__actions">
          <button type="button" disabled={mutationBusy} onClick={() => setEditing(null)}>取消</button>
          <button type="submit" className="is-primary" disabled={mutationBusy || !editStyleNo.trim() || !editDocumentQuantity || editActualQuantity === "" || editDefectiveQuantity === ""}>{mutationBusy ? "保存中…" : "保存修改"}</button>
        </div>
      </form>
    </div> : null}

    {deleting ? <div className="order-board-dialog-backdrop" role="presentation" onMouseDown={() => !mutationBusy && setDeleting(null)}>
      <div className="order-board-dialog order-board-delete-dialog" role="dialog" aria-modal="true" aria-label="删除收货订单" onMouseDown={(event) => event.stopPropagation()}>
        <h2>确认删除收货订单？</h2>
        <p>款号：<strong>{deleting.styleNo}</strong></p>
        <p>删除后从订单看板隐藏，原始收货记录与图片仍保留审计。此操作仅限尚未发起返工的订单。</p>
        {mutationMessage ? <p className="order-board-dialog__error" role="alert">{mutationMessage}</p> : null}
        <div className="order-board-dialog__actions">
          <button type="button" disabled={mutationBusy} onClick={() => setDeleting(null)}>取消</button>
          <button type="button" className="is-danger" disabled={mutationBusy} onClick={() => void confirmDelete()}>{mutationBusy ? "删除中…" : "确认删除"}</button>
        </div>
      </div>
    </div> : null}
  </div>;
}
