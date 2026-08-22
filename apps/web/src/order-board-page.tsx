import { KpiInstrument, StatusBadge, Surface } from "@dx-rework/ui";
import { useEffect, useMemo, useState } from "react";

import { createWebUrls } from "../url-contract.js";
import "./order-board-page.css";

const { apiUrl, pageUrl } = createWebUrls(import.meta.env.BASE_URL);

type BoardRow = Readonly<{
  styleNo: string;
  documentQuantity: number;
  actualQuantity: number;
  differenceQuantity: number;
  receiptCount: number;
  lastReceivedAt: string;
  lastReceiverName: string;
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

type BoardMe = Readonly<{
  status: string;
  user?: Readonly<{
    isRoot?: boolean;
    businessRoles?: readonly string[];
    capabilities: readonly string[];
  }>;
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

export function OrderBoardPage() {
  const [date, setDate] = useState(localDate);
  const [query, setQuery] = useState("");
  const [data, setData] = useState<BoardResult | null>(null);
  const [message, setMessage] = useState("正在加载订单看板…");
  const [canReceive, setCanReceive] = useState(false);
  const [canInitiate, setCanInitiate] = useState(false);

  useEffect(() => {
    let active = true;
    void fetch(apiUrl("auth/me"), { credentials: "include", cache: "no-store" })
      .then(async (response) => response.ok ? await response.json() as BoardMe : null)
      .then((body) => {
        if (!active || body?.status !== "authorized" || !body.user) return;
        const isRoot = body.user.isRoot === true;
        const roles = body.user.businessRoles ?? [];
        const capabilities = body.user.capabilities;
        const warehouseReceiver = roles.includes("warehouse_receiver")
          && capabilities.includes("receiving:create");
        const qualityControl = roles.includes("quality_control")
          && capabilities.includes("rework:initiate");
        setCanReceive(isRoot || warehouseReceiver);
        setCanInitiate(isRoot || roles.includes("owner_group") || qualityControl);
      })
      .catch(() => {
        if (!active) return;
        setCanReceive(false);
        setCanInitiate(false);
      });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams({ date });
      if (query.trim()) params.set("q", query.trim());
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
          setData(null);
          setMessage("订单看板加载失败，请刷新后重试");
        });
    }, 180);
    return () => { active = false; window.clearTimeout(timer); };
  }, [date, query]);

  const kpis = useMemo(() => data?.kpis ?? {
    orderCount: 0,
    receivedQuantity: 0,
    abnormalOrderCount: 0,
    differenceQuantity: 0,
    differenceRate: 0,
  }, [data]);

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
      <KpiInstrument label="今日收货数量" value={`${kpis.receivedQuantity}件`} detail={date} tone="info" />
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
        const initiateHref = `${pageUrl("ui/qc/new")}?styleNo=${encodeURIComponent(row.styleNo)}`;
        return <Surface className={`order-board-row is-${tone}`} key={row.styleNo}>
          <div className="order-board-row__style">
            <span>款号</span>
            <div className="order-board-row__style-line">
              <strong>{row.styleNo}</strong>
              <StatusBadge tone={tone === "short" ? "danger" : tone === "extra" ? "info" : "success"}>
                {tone === "short" ? "少收" : tone === "extra" ? "多收" : "正常"}
              </StatusBadge>
              {canInitiate ? <a className="order-board-rework-link order-board-rework-link--desktop" href={initiateHref}>发起返工</a> : null}
            </div>
          </div>
          <div><span>收货单</span><strong>{row.documentQuantity}件</strong></div>
          <div><span>实收</span><strong>{row.actualQuantity}件</strong></div>
          <div className="order-board-row__difference"><span>差异</span><strong>{signed}件</strong></div>
          <div><span>收货次数</span><strong>{row.receiptCount}次</strong></div>
          <div><span>最近收货</span><strong>{dateTime(row.lastReceivedAt)}</strong></div>
          <div><span>收货人</span><strong>{row.lastReceiverName}</strong></div>
          {canInitiate ? <a className="order-board-rework-link order-board-rework-link--mobile" href={initiateHref}>发起返工</a> : null}
        </Surface>;
      })}
    </div>
    {message ? <p className="order-board-message" role="status">{message}</p> : null}
  </div>;
}
