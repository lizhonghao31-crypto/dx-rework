import { calculateSourcingTotalExact } from "@dx-rework/contracts";
import type {
  SourcingCaseListResponse,
  SourcingCaseStatus,
  SourcingCaseSummary,
} from "@dx-rework/contracts";
import { StatusBadge, Surface } from "@dx-rework/ui";
import { useEffect, useMemo, useRef, useState } from "react";

import { createWebUrls } from "../url-contract.js";
import { verifySession, type AuthorizedUser } from "./auth.js";
import "./sourcing-shell.css";

const { apiUrl } = createWebUrls(import.meta.env.BASE_URL);

const STATUS_LABELS: Readonly<Record<SourcingCaseStatus, string>> = {
  pending_ie_quote: "待 IE 报价",
  pending_management_decision: "待生产管理调价选厂",
  pending_owner_approval: "待老板终审",
  pending_contract: "待登记合同",
  pending_finance_reconciliation: "待财务核对",
  pending_factory_change_verification: "待核实换厂",
  pending_exception_verification: "待核实差异",
  closed: "已完成",
};

type QuoteDraft = Readonly<{ unitPrice: string; quoteReason: string }>;

const errorMessage = async (response: Response): Promise<string> => {
  const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
  return body?.error?.message ?? "操作失败，请稍后重试";
};

const requestJson = async <T,>(path: string, init: RequestInit = {}): Promise<T> => {
  const response = await fetch(apiUrl(path), {
    credentials: "include",
    cache: "no-store",
    ...init,
    headers: {
      accept: "application/json",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) throw new Error(await errorMessage(response));
  return response.json() as Promise<T>;
};

const canAct = (
  user: AuthorizedUser | null,
  role: string,
  capability: string,
): boolean => user?.isRoot === true
  || (
    user?.businessRoles?.includes(role) === true
    && user.capabilities.includes(capability)
  );

const totalPreview = (unitPrice: string, quantity: number): string => {
  if (!/^\d{1,10}(?:\.\d{1,4})?$/.test(unitPrice) || Number(unitPrice) <= 0) return "—";
  try {
    const [whole, fraction] = calculateSourcingTotalExact(unitPrice, quantity).split(".");
    return `${whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${fraction}`;
  } catch {
    return "—";
  }
};

const formatDateTime = (value: string): string =>
  new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));

export function SourcingShellPage() {
  const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
  const [user, setUser] = useState<AuthorizedUser | null>(null);
  const [cases, setCases] = useState<readonly SourcingCaseSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [erpOrderNo, setErpOrderNo] = useState("");
  const [styleNo, setStyleNo] = useState("");
  const [orderQuantity, setOrderQuantity] = useState("");
  const [quoteDrafts, setQuoteDrafts] = useState<Readonly<Record<string, QuoteDraft>>>({});
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const createKey = useRef<string | null>(null);
  const quoteKeys = useRef(new Map<string, string>());

  const loadCases = async (query = search) => {
    setLoading(true);
    try {
      const body = await requestJson<SourcingCaseListResponse>(
        `sourcing/cases?q=${encodeURIComponent(query.trim())}`,
      );
      setCases(body.items);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "询价列表加载失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let mounted = true;
    void verifySession().then((session) => {
      if (!mounted || session === "denied" || session.status !== "authorized") return;
      setUser(session.user);
    });
    void loadCases("");
    return () => {
      mounted = false;
    };
  }, []);

  const canCreate = canAct(user, "order_merchandiser", "sourcing:inquiry:create");
  const canQuote = canAct(user, "ie_reviewer", "sourcing:price:quote");
  const pendingIeCount = useMemo(
    () => cases.filter((item) => item.status === "pending_ie_quote").length,
    [cases],
  );

  const createCase = async () => {
    const quantity = Number(orderQuantity);
    if (!erpOrderNo.trim()) { setMessage("请输入 ERP 订单号"); return; }
    if (!styleNo.trim()) { setMessage("请输入款号"); return; }
    if (!/^\d+$/.test(orderQuantity) || quantity < 1 || quantity > 10_000_000) {
      setMessage("订单数量必须是1至10000000之间的整数");
      return;
    }
    setBusyAction("create");
    setMessage("正在创建询价…");
    createKey.current ??= window.crypto.randomUUID();
    try {
      await requestJson<SourcingCaseSummary>("sourcing/cases", {
        method: "POST",
        headers: { "idempotency-key": createKey.current },
        body: JSON.stringify({
          erpOrderNo: erpOrderNo.trim(),
          styleNo: styleNo.trim(),
          orderQuantity: quantity,
        }),
      });
      createKey.current = null;
      setErpOrderNo("");
      setStyleNo("");
      setOrderQuantity("");
      setMessage("询价已创建，已进入 IE 报价队列");
      await loadCases("");
      setSearch("");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "询价创建失败");
    } finally {
      setBusyAction(null);
    }
  };

  const quoteDraft = (sourcingCaseId: string): QuoteDraft =>
    quoteDrafts[sourcingCaseId] ?? { unitPrice: "", quoteReason: "" };

  const updateQuoteDraft = (
    sourcingCaseId: string,
    field: keyof QuoteDraft,
    value: string,
  ) => {
    setQuoteDrafts((current) => ({
      ...current,
      [sourcingCaseId]: { ...quoteDraft(sourcingCaseId), [field]: value },
    }));
    quoteKeys.current.delete(sourcingCaseId);
  };

  const quoteCase = async (item: SourcingCaseSummary) => {
    const draft = quoteDraft(item.sourcingCaseId);
    if (!/^\d{1,10}(?:\.\d{1,4})?$/.test(draft.unitPrice) || Number(draft.unitPrice) <= 0) {
      setMessage("加工单价必须大于0且最多4位小数");
      return;
    }
    if (draft.quoteReason.trim().length > 500) {
      setMessage("价格说明不能超过500个字符");
      return;
    }
    setBusyAction(item.sourcingCaseId);
    setMessage(`正在提交 ${item.erpOrderNo} 的 IE 价格…`);
    let key = quoteKeys.current.get(item.sourcingCaseId);
    if (!key) {
      key = window.crypto.randomUUID();
      quoteKeys.current.set(item.sourcingCaseId, key);
    }
    try {
      await requestJson<SourcingCaseSummary>(
        `sourcing/cases/${item.sourcingCaseId}/ie-quotes`,
        {
          method: "POST",
          headers: { "idempotency-key": key },
          body: JSON.stringify({
            unitPrice: draft.unitPrice,
            ...(draft.quoteReason.trim() ? { quoteReason: draft.quoteReason.trim() } : {}),
          }),
        },
      );
      quoteKeys.current.delete(item.sourcingCaseId);
      setQuoteDrafts((current) => {
        const next = { ...current };
        delete next[item.sourcingCaseId];
        return next;
      });
      setMessage("IE 价格已提交，已转交生产管理调价选厂");
      await loadCases(search);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "IE价格提交失败");
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <main className="sourcing-shell">
      <header className="sourcing-shell__header">
        <div>
          <StatusBadge tone="info">达兴 · 业务平台</StatusBadge>
          <h1>报价&选厂</h1>
          <p>跟单建立订单询价，IE 提供加工价格；生产管理选厂将在下一阶段开放。</p>
        </div>
        <a className="dx-button dx-button--secondary" href={`${basePath}/ui/home`}>
          返回业务工作台
        </a>
      </header>

      <section className={`sourcing-shell__layout${canCreate ? "" : " is-single"}`}>
        {canCreate ? (
          <Surface className="sourcing-shell__create">
            <div className="sourcing-shell__section-heading">
              <div>
                <small>跟单操作</small>
                <h2>创建询价</h2>
              </div>
              <StatusBadge tone="info">加工厂</StatusBadge>
            </div>
            <label className="sourcing-shell__field">
              <span>ERP 订单号</span>
              <input
                value={erpOrderNo}
                maxLength={100}
                onChange={(event) => {
                  setErpOrderNo(event.target.value);
                  createKey.current = null;
                }}
                placeholder="请输入正式 ERP 订单号"
              />
            </label>
            <label className="sourcing-shell__field">
              <span>款号</span>
              <input
                value={styleNo}
                maxLength={100}
                onChange={(event) => {
                  setStyleNo(event.target.value);
                  createKey.current = null;
                }}
                placeholder="请输入款号"
              />
            </label>
            <label className="sourcing-shell__field">
              <span>订单数量</span>
              <input
                value={orderQuantity}
                inputMode="numeric"
                onChange={(event) => {
                  setOrderQuantity(event.target.value);
                  createKey.current = null;
                }}
                placeholder="请输入整数"
              />
            </label>
            <button
              className="dx-button dx-button--primary sourcing-shell__primary-action"
              type="button"
              disabled={busyAction !== null}
              onClick={() => void createCase()}
            >
              {busyAction === "create" ? "正在创建…" : "创建并交给 IE"}
            </button>
          </Surface>
        ) : null}

        <Surface className="sourcing-shell__queue">
          <div className="sourcing-shell__section-heading">
            <div>
              <small>业务队列</small>
              <h2>询价记录</h2>
            </div>
            <StatusBadge tone="info">{pendingIeCount} 个待 IE</StatusBadge>
          </div>

          <form
            className="sourcing-shell__search"
            onSubmit={(event) => {
              event.preventDefault();
              void loadCases(search);
            }}
          >
            <input
              value={search}
              maxLength={100}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="搜索 ERP 订单号或款号"
            />
            <button className="dx-button dx-button--secondary" type="submit">搜索</button>
          </form>

          {message ? <p className="sourcing-shell__message" role="status">{message}</p> : null}
          {loading ? <p className="sourcing-shell__empty">正在加载询价记录…</p> : null}
          {!loading && cases.length === 0 ? (
            <p className="sourcing-shell__empty">暂无符合条件的询价记录</p>
          ) : null}

          <div className="sourcing-shell__cases">
            {cases.map((item) => {
              const draft = quoteDraft(item.sourcingCaseId);
              return (
                <article className="sourcing-case" key={item.sourcingCaseId}>
                  <div className="sourcing-case__heading">
                    <div>
                      <strong>{item.erpOrderNo}</strong>
                      <span>款号 {item.styleNo}</span>
                    </div>
                    <StatusBadge tone="info">{STATUS_LABELS[item.status]}</StatusBadge>
                  </div>
                  <dl className="sourcing-case__facts">
                    <div><dt>数量</dt><dd>{item.orderQuantity.toLocaleString("zh-CN")}</dd></div>
                    <div><dt>工艺</dt><dd>加工厂</dd></div>
                    <div><dt>更新时间</dt><dd>{formatDateTime(item.updatedAt)}</dd></div>
                    {item.ieQuote ? (
                      <>
                        <div><dt>IE 单价</dt><dd>¥{item.ieQuote.unitPrice}</dd></div>
                        <div><dt>总额</dt><dd>¥{item.ieQuote.totalAmount}</dd></div>
                        <div><dt>报价版本</dt><dd>V{item.ieQuote.quoteVersion}</dd></div>
                      </>
                    ) : null}
                  </dl>

                  {item.status === "pending_ie_quote" && canQuote ? (
                    <div className="sourcing-case__quote">
                      <label className="sourcing-shell__field">
                        <span>加工单价</span>
                        <input
                          value={draft.unitPrice}
                          inputMode="decimal"
                          onChange={(event) => updateQuoteDraft(
                            item.sourcingCaseId,
                            "unitPrice",
                            event.target.value,
                          )}
                          placeholder="最多4位小数"
                        />
                      </label>
                      <div className="sourcing-case__total">
                        <span>系统计算总额</span>
                        <strong>¥{totalPreview(draft.unitPrice, item.orderQuantity)}</strong>
                      </div>
                      <label className="sourcing-shell__field sourcing-case__reason">
                        <span>价格说明（可选）</span>
                        <input
                          value={draft.quoteReason}
                          maxLength={500}
                          onChange={(event) => updateQuoteDraft(
                            item.sourcingCaseId,
                            "quoteReason",
                            event.target.value,
                          )}
                          placeholder="有特殊情况时填写"
                        />
                      </label>
                      <button
                        className="dx-button dx-button--primary"
                        type="button"
                        disabled={busyAction !== null}
                        onClick={() => void quoteCase(item)}
                      >
                        {busyAction === item.sourcingCaseId ? "正在提交…" : "确认 IE 价格"}
                      </button>
                    </div>
                  ) : null}

                  {item.status === "pending_ie_quote" && !canQuote ? (
                    <p className="sourcing-case__next">已交给 IE，等待填写加工价格。</p>
                  ) : null}
                  {item.status === "pending_management_decision" ? (
                    <p className="sourcing-case__next">IE 已报价，等待生产管理调整价格并选择加工厂。</p>
                  ) : null}
                </article>
              );
            })}
          </div>
        </Surface>
      </section>
    </main>
  );
}
