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

  useEffect(() => {
    let active = true;
    void fetch(apiUrl("auth/me"), { credentials: "include", cache: "no-store" })
      .then(async (response) => response.ok ? await response.json() as BoardMe : null)
      .then((body) => {
        if (!active || body?.status !== "authorized" || !body.user) return;
        const warehouseReceiver = body.user.businessRoles?.includes("warehouse_receiver") === true
          && body.user.capabilities.includes("receiving:create");
        setCanReceive(body.user.isRoot === true || warehouseReceiver);
      })
      .catch(() => { if (active) setCanReceive(false); });
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
      <KpiInstrument label="收货订单" value={kpis.orderCount} detail="所选日期涉及款号" tone="info" />
      <KpiInstrument label="实际收货" value={`${kpis.receivedQuantity}件`} detail="所选日期收货总数" tone="info" />
      <KpiInstrument label="当前差异" value={`${kpis.differenceQuantity}件`} detail="按订单净差异绝对值汇总" tone={kpis.differenceQuantity ? "warning" : "success"} />
      <KpiInstrument label="差异率" value={`${kpis.differenceRate}%`} detail="同款多次收货可互相抵消" tone={kpis.differenceRate ? "warning" : "success"} />
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
        return <Surface className={`order-board-row is-${tone}`} key={row.styleNo}>
          <div className="order-board-row__style">
            <span>款号</span>
            <strong>{row.styleNo}</strong>
          </div>
          <div><span>收货单</span><strong>{row.documentQuantity}件</strong></div>
          <div><span>实收</span><strong>{row.actualQuantity}件</strong></div>
          <div className="order-board-row__difference"><span>差异</span><strong>{signed}件</strong></div>
          <div><span>收货次数</span><strong>{row.receiptCount}次</strong></div>
          <div><span>最近收货</span><strong>{dateTime(row.lastReceivedAt)}</strong></div>
          <div><span>收货人</span><strong>{row.lastReceiverName}</strong></div>
          <StatusBadge tone={tone === "short" ? "danger" : tone === "extra" ? "info" : "success"}>
            {tone === "short" ? "少收" : tone === "extra" ? "多收" : "正常"}
          </StatusBadge>
        </Surface>;
      })}
    </div>
    {message ? <p className="order-board-message" role="status">{message}</p> : null}
  </div>;
}
