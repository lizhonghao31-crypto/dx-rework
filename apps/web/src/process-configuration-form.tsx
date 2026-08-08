import {
  ProcessConfigurationOptionsResponseSchema,
  ProcessConfigurationResponseSchema,
  type ProcessConfigurationOptionsResponse,
  type ProcessConfigurationResponse,
} from "@dx-rework/contracts";
import { Button, InsetField, StatusBadge, Surface } from "@dx-rework/ui";
import { useEffect, useState, type ReactNode } from "react";

import { createWebUrls } from "../url-contract.js";

const { apiUrl } = createWebUrls(import.meta.env.BASE_URL);

type User = {
  businessRoles?: readonly string[];
  capabilities: readonly string[];
  isRoot?: boolean;
};
type ItemForm = {
  source: "catalog" | "custom";
  processId: string;
  customProcessName: string;
  plannedQuantity: string;
  pricingUnit: "piece" | "hour";
  unitPrice: string;
};

const emptyItem = (): ItemForm => ({
  source: "catalog",
  processId: "",
  customProcessName: "",
  plannedQuantity: "",
  pricingUnit: "piece",
  unitPrice: "",
});

function SelectField({ label, children }: { label: string; children: ReactNode }) {
  return <label className="dx-field">
    <span>{label}</span>
    <span className="dx-field__control">{children}</span>
  </label>;
}

const errorMessage = async (response: Response): Promise<string> => {
  try {
    const body = await response.json() as { error?: { message?: string } };
    return body.error?.message ?? "请求未完成，请稍后重试";
  } catch {
    return "请求未完成，请稍后重试";
  }
};

async function request<T>(
  path: string,
  schema: { parse(value: unknown): T },
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(apiUrl(path), {
    credentials: "include",
    ...init,
    headers: {
      accept: "application/json",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
  if (!response.ok) throw new Error(await errorMessage(response));
  return schema.parse(await response.json());
}

const toItem = (
  item: NonNullable<ProcessConfigurationResponse["configuration"]>["items"][number],
): ItemForm => ({
  source: item.source,
  processId: item.processId ?? "",
  customProcessName: item.source === "custom" ? item.processName : "",
  plannedQuantity: item.plannedQuantity.toString(),
  pricingUnit: item.pricingUnit,
  unitPrice: item.unitPrice.toFixed(3),
});

const statusLabel = (response: ProcessConfigurationResponse): string => {
  if (response.reworkStatus === "pending_process_configuration") return "待李同生配置";
  if (response.reworkStatus === "pending_ie_review") return "待郎飞 IE 审核";
  if (response.reworkStatus === "pending_task_assignment") return "工序已生效 · 待分工";
  return "当前状态不在工序配置节点";
};

export function ProcessConfigurationForm() {
  const reworkOrderId = new URLSearchParams(window.location.search).get("rework");
  const [user, setUser] = useState<User | null>(null);
  const [options, setOptions] = useState<ProcessConfigurationOptionsResponse>({ processes: [] });
  const [response, setResponse] = useState<ProcessConfigurationResponse | null>(null);
  const [items, setItems] = useState<ItemForm[]>([emptyItem()]);
  const [changeReason, setChangeReason] = useState("");
  const [reviewReason, setReviewReason] = useState("");
  const [message, setMessage] = useState("正在加载工序配置…");
  const [busy, setBusy] = useState(false);

  const canConfigure = user?.isRoot === true || Boolean(
    user?.businessRoles?.includes("tail_supervisor")
    && user.capabilities.includes("process:configure"),
  );
  const canReview = user?.isRoot === true || Boolean(
    user?.businessRoles?.includes("ie_reviewer")
    && user.capabilities.includes("process:review"),
  );
  const configuration = response?.configuration ?? null;
  const editable = Boolean(
    canConfigure
    && response
    && (response.reworkStatus === "pending_process_configuration"
      || response.reworkStatus === "pending_task_assignment"),
  );
  const reviewable = Boolean(canReview && response?.reworkStatus === "pending_ie_review");

  const reload = async () => {
    if (!reworkOrderId) return;
    const [me, loaded] = await Promise.all([
      request("auth/me", { parse: (value) => value as { user: User } }),
      request(
        "rework-orders/" + reworkOrderId + "/process-configuration",
        ProcessConfigurationResponseSchema,
      ),
    ]);
    setUser(me.user);
    setResponse(loaded);
    if (loaded.configuration && loaded.configuration.status !== "pending_ie_review") {
      setItems(loaded.configuration.items.map(toItem));
      setChangeReason(loaded.configuration.changeReason ?? "");
    }
    setMessage(statusLabel(loaded));
  };

  useEffect(() => {
    if (!reworkOrderId) {
      setMessage("缺少返工单编号。请从待办或返工单详情进入工序配置。");
      return;
    }
    void request("auth/me", { parse: (value) => value as { user: User } }).then(async (me) => {
      setUser(me.user);
      const canLoadOptions = me.user.isRoot === true || Boolean(
        me.user.businessRoles?.includes("tail_supervisor")
        && me.user.capabilities.includes("process:configure"),
      );
      const loadedOptions = canLoadOptions
        ? await request("rework-process-configurations/options", ProcessConfigurationOptionsResponseSchema)
        : { processes: [] };
      setOptions(loadedOptions);
      return reload();
    }).catch((error: unknown) => {
      setMessage(error instanceof Error ? error.message : "工序配置加载失败");
    });
  }, [reworkOrderId]);

  const setItem = (index: number, next: Partial<ItemForm>) => {
    setItems((current) => current.map((item, itemIndex) =>
      itemIndex === index ? { ...item, ...next } : item,
    ));
  };

  const payloadItems = () => items.map((item) => ({
    source: item.source,
    ...(item.source === "catalog"
      ? { processId: item.processId }
      : { customProcessName: item.customProcessName }),
    plannedQuantity: Number(item.plannedQuantity),
    pricingUnit: item.pricingUnit,
    unitPrice: Number(item.unitPrice),
  }));

  const save = async () => {
    if (!response || !editable || busy) return;
    setBusy(true);
    try {
      const saved = await request(
        "rework-orders/" + response.reworkOrderId + "/process-configuration/draft",
        ProcessConfigurationResponseSchema,
        {
          method: "PUT",
          headers: { "idempotency-key": crypto.randomUUID() },
          body: JSON.stringify({
            expectedOrderVersion: response.orderVersion,
            items: payloadItems(),
            ...(response.reworkStatus === "pending_task_assignment"
              ? { changeReason }
              : {}),
          }),
        },
      );
      setResponse(saved);
      setItems(saved.configuration?.items.map(toItem) ?? [emptyItem()]);
      setMessage("工序配置草稿已保存；价格按 3 位小数只舍不入保存。");
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : "草稿保存失败");
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    if (!response || !configuration || !editable || busy) return;
    if (!window.confirm("确认提交工序、计划数量与单价给 IE 审核？")) return;
    setBusy(true);
    try {
      const submitted = await request(
        "rework-orders/" + response.reworkOrderId + "/process-configuration/submit",
        ProcessConfigurationResponseSchema,
        {
          method: "POST",
          headers: { "idempotency-key": crypto.randomUUID() },
          body: JSON.stringify({
            expectedOrderVersion: response.orderVersion,
            expectedConfigurationVersion: configuration.configurationVersion,
          }),
        },
      );
      setResponse(submitted);
      setMessage("已提交给 IE 审核；提交后不能直接覆盖工序和单价。");
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : "提交IE审核失败");
    } finally {
      setBusy(false);
    }
  };

  const review = async (decision: "approved" | "rejected") => {
    if (!response || !configuration || !reviewable || busy) return;
    if (decision === "rejected" && !reviewReason.trim()) {
      setMessage("IE 驳回必须填写原因。");
      return;
    }
    if (!window.confirm(decision === "approved" ? "确认审核通过并使工序生效？" : "确认驳回并退回尾部主管修改？")) {
      return;
    }
    setBusy(true);
    try {
      const reviewed = await request(
        "rework-orders/" + response.reworkOrderId + "/process-configuration/review",
        ProcessConfigurationResponseSchema,
        {
          method: "POST",
          headers: { "idempotency-key": crypto.randomUUID() },
          body: JSON.stringify({
            expectedOrderVersion: response.orderVersion,
            expectedConfigurationVersion: configuration.configurationVersion,
            decision,
            reason: reviewReason.trim() || undefined,
          }),
        },
      );
      setResponse(reviewed);
      setMessage(decision === "approved"
        ? "IE 已通过；工序已生效，自定义工序已进入公共工序库。"
        : "IE 已驳回；原因已保留，等待尾部主管重新配置。");
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : "IE审核提交失败");
    } finally {
      setBusy(false);
    }
  };

  return <main className="mobile-page process-configuration-page">
    <div className="mobile-hero">
      <div className="mobile-title">
        <h1>工序配置与 IE 审核</h1>
        <StatusBadge tone={response?.reworkStatus === "pending_ie_review" ? "warning" : "info"}>
          {response ? statusLabel(response) : "加载中"}
        </StatusBadge>
      </div>
      <p>{response?.reworkNo ?? "返工单"} · {response ? "订单版本 " + response.orderVersion : "请稍候"}</p>
      <StatusBadge tone="success">计划数量、单位、单价全程留痕</StatusBadge>
    </div>

    <Surface className="process-status">
      <h2>当前处理说明</h2>
      <p>{message}</p>
      {configuration?.status === "rejected" && configuration.reviewReason && (
        <div className="qc-warning"><b>IE 驳回原因：</b>{configuration.reviewReason}</div>
      )}
      {configuration?.kind === "change" && (
        <StatusBadge tone="warning">变更单 V{configuration.configurationVersion} · 已生效历史不会被覆盖</StatusBadge>
      )}
    </Surface>

    {editable && <Surface>
      <div className="section-title">
        <div>
          <h2>工序、计划数量与单价</h2>
          <p>件必须为整数；小时保留 2 位；单价只舍不入保留 3 位。</p>
        </div>
        <Button onClick={() => setItems((current) => [...current, emptyItem()])} disabled={busy}>增加工序</Button>
      </div>
      <div className="process-lines">
        {items.map((item, index) => <div className="process-line" key={index}>
          <div className="process-line__title">
            <b>工序 {index + 1}</b>
            {items.length > 1 && <Button onClick={() => setItems((current) => current.filter((_, itemIndex) => itemIndex !== index))} disabled={busy}>删除</Button>}
          </div>
          <label className="process-source"><input type="radio" checked={item.source === "catalog"} onChange={() => setItem(index, { source: "catalog", customProcessName: "" })} disabled={busy} /> 公共工序</label>
          <label className="process-source"><input type="radio" checked={item.source === "custom"} onChange={() => setItem(index, { source: "custom", processId: "" })} disabled={busy} /> 自定义工序</label>
          {item.source === "catalog"
            ? <SelectField label="选择公共工序"><select value={item.processId} onChange={(event) => {
              const selected = options.processes.find((process) => process.processId === event.target.value);
              setItem(index, {
                processId: event.target.value,
                pricingUnit: selected?.pricingUnit ?? item.pricingUnit,
              });
            }} disabled={busy}><option value="">请选择</option>{options.processes.map((process) => <option key={process.processId} value={process.processId}>{process.processName} · {process.pricingUnit === "piece" ? "件" : "小时"}</option>)}</select></SelectField>
            : <InsetField label="自定义工序" value={item.customProcessName} onChange={(event) => setItem(index, { customProcessName: event.target.value })} disabled={busy} placeholder="例如：特殊翻边返修" />}
          <div className="process-line__grid">
            <InsetField label={item.pricingUnit === "piece" ? "计划数量（件）" : "计划工时（小时）"} inputMode="decimal" value={item.plannedQuantity} onChange={(event) => setItem(index, { plannedQuantity: event.target.value })} disabled={busy} />
            <SelectField label="计价单位"><select value={item.pricingUnit} onChange={(event) => setItem(index, { pricingUnit: event.target.value as ItemForm["pricingUnit"] })} disabled={busy}><option value="piece">件</option><option value="hour">小时</option></select></SelectField>
          </div>
          <InsetField label="单价（元）" inputMode="decimal" value={item.unitPrice} onChange={(event) => setItem(index, { unitPrice: event.target.value })} disabled={busy} placeholder="0.000" />
        </div>)}
      </div>
      {response?.reworkStatus === "pending_task_assignment" && <InsetField label="变更原因" value={changeReason} onChange={(event) => setChangeReason(event.target.value)} disabled={busy} placeholder="说明改价或改数量的业务原因" />}
      <div className="mobile-actions">
        <Button onClick={() => void save()} disabled={busy}>保存配置草稿</Button>
        <Button variant="primary" onClick={() => void submit()} disabled={busy || !configuration}>提交 IE 审核</Button>
      </div>
    </Surface>}

    {!editable && configuration && <Surface>
      <h2>本次工序配置 V{configuration.configurationVersion}</h2>
      <div className="process-readonly-list">
        {configuration.items.map((item) => <div key={item.configurationItemId}>
          <b>{item.processName}</b>
          <small>{item.source === "custom" ? "自定义工序" : "公共工序"} · 计划 {item.plannedQuantity} {item.pricingUnit === "piece" ? "件" : "小时"} · ¥{item.unitPrice.toFixed(3)} / {item.pricingUnit === "piece" ? "件" : "小时"}</small>
        </div>)}
      </div>
    </Surface>}

    {reviewable && <Surface className="ie-review">
      <h2>IE 审核</h2>
      <p>郎飞确认计划数量、计价单位与单价。通过后配置生效；驳回必须留下原因。</p>
      <InsetField label="审核意见 / 驳回原因" value={reviewReason} onChange={(event) => setReviewReason(event.target.value)} disabled={busy} placeholder="通过时可选；驳回时必填" />
      <div className="qc-secondary-actions">
        <Button onClick={() => void review("rejected")} disabled={busy}>驳回修改</Button>
        <Button variant="primary" onClick={() => void review("approved")} disabled={busy}>审核通过并生效</Button>
      </div>
    </Surface>}
  </main>;
}
