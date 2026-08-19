import {
  TailInspectionResponseSchema,
  type TailInspectionResponse,
} from "@dx-rework/contracts";
import { Button, InsetField, StatusBadge, Surface } from "@dx-rework/ui";
import { useEffect, useState } from "react";

import { createWebUrls } from "../url-contract.js";
import { confirmInApp } from "./system-dialog.js";
import "./tail-inspection-panel.css";

const { apiUrl } = createWebUrls(import.meta.env.BASE_URL);

const request = async <T,>(path: string, parse: (value: unknown) => T, init?: RequestInit): Promise<T> => {
  const response = await fetch(apiUrl(path), {
    credentials: "include",
    ...init,
    headers: {
      accept: "application/json",
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
    throw new Error(body?.error?.message ?? "请求未完成，请稍后重试");
  }
  return parse(await response.json());
};

const isPieceCount = (value: string): boolean => /^\d+$/.test(value) && Number(value) >= 0;

export function TailInspectionPanel({
  reworkOrderId,
  onOrderChanged,
  isRoot = false,
}: {
  reworkOrderId: string;
  onOrderChanged?: () => Promise<void> | void;
  isRoot?: boolean;
}) {
  const [data, setData] = useState<TailInspectionResponse | null>(null);
  const [returnedQuantity, setReturnedQuantity] = useState("");
  const [processQuantities, setProcessQuantities] = useState<Record<string, string>>({});
  const [autoFilledFor, setAutoFilledFor] = useState("");
  const [message, setMessage] = useState("正在加载尾查任务…");
  const [busy, setBusy] = useState(false);

  const load = async (): Promise<TailInspectionResponse> => {
    const result = await request(
      `rework-orders/${reworkOrderId}/tail-inspection`,
      TailInspectionResponseSchema.parse,
    );
    setData(result);
    setMessage(result.assignments.some((assignment) => assignment.canSubmit)
      ? isRoot
        ? "Root 可代理未报数尾查提交；先选择系统提供的可代报任务并填写实际清点数量。"
        : "先填本次返件总数；每道工序会默认同步总数，按实际清点结果修改即可。"
      : "当前尾查报数已提交，或尚未到本人处理。"
    );
    return result;
  };

  useEffect(() => {
    void load().catch((error: unknown) => {
      setMessage(error instanceof Error ? error.message : "尾查任务加载失败");
    });
  }, [isRoot, reworkOrderId]);

  const updateReturnedQuantity = (nextValue: string) => {
    setReturnedQuantity(nextValue);
    if (!isPieceCount(nextValue) || Number(nextValue) <= 0 || !data) return;
    setProcessQuantities((current) => Object.fromEntries(data.processes.map((process) => {
      const currentValue = current[process.configurationItemId] ?? "";
      const followsPreviousTotal = currentValue === "" || currentValue === autoFilledFor;
      return [process.configurationItemId, followsPreviousTotal ? nextValue : currentValue];
    })));
    setAutoFilledFor(nextValue);
  };

  const submit = async () => {
    if (!data || busy) return;
    const assignment = data.assignments.find((item) => item.canSubmit);
    if (!assignment) {
      setMessage("当前没有可提交的尾查任务。 ");
      return;
    }
    const returned = returnedQuantity.trim();
    if (!/^\d+$/.test(returned) || Number(returned) <= 0) {
      setMessage("返件总数必须填写为大于 0 的整数件数。 ");
      return;
    }
    const items = data.processes.map((process) => ({
      configurationItemId: process.configurationItemId,
      inspectedQuantity: Number(processQuantities[process.configurationItemId]?.trim() ?? ""),
      processName: process.processName,
    }));
    if (items.some((item) => !Number.isInteger(item.inspectedQuantity) || item.inspectedQuantity < 0)) {
      setMessage("每道工序都必须填写整数件数；没有该工序返件时请填 0。 ");
      return;
    }
    if (items.some((item) => item.inspectedQuantity > Number(returned))) {
      setMessage("单道工序的清点数量不能超过本次返件总数。 ");
      return;
    }
    const confirmation = isRoot
      ? `确认以 Root 身份代 ${assignment.tailInspectorName} 提交尾查报数？提交后如需调整，请由尾部主管退回后重新报数。`
      : "确认提交本人的尾查报数？提交后如需调整，请由尾部主管退回后重新报数。";
    if (!(await confirmInApp(confirmation))) return;
    setBusy(true);
    try {
      const submitted = await request(
        `tail-inspection-assignments/${assignment.assignmentId}/reports`,
        TailInspectionResponseSchema.parse,
        {
          method: "POST",
          headers: { "idempotency-key": crypto.randomUUID() },
          body: JSON.stringify({
            returnedQuantity: Number(returned),
            items: items.map(({ configurationItemId, inspectedQuantity }) => ({ configurationItemId, inspectedQuantity })),
          }),
        },
      );
      setData(submitted);
      setMessage("尾查报数已提交。系统会与工人完工上数并行等待，二者完成后才进入尾部主管整单确认。 ");
      await onOrderChanged?.();
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : "尾查报数提交失败");
    } finally {
      setBusy(false);
    }
  };

  const actionableAssignment = data?.assignments.find((assignment) => assignment.canSubmit) ?? null;
  const submittedAssignments = data?.assignments.filter((assignment) => assignment.submittedAt !== null) ?? [];
  const returnedReady = /^\d+$/.test(returnedQuantity.trim()) && Number(returnedQuantity) > 0;
  const processCountsReady = Boolean(data && data.processes.every((process) => {
    const text = processQuantities[process.configurationItemId]?.trim() ?? "";
    return text !== "" && isPieceCount(text);
  }));
  const processCountsWithinReturned = Boolean(data && returnedReady && data.processes.every((process) =>
    Number(processQuantities[process.configurationItemId]) <= Number(returnedQuantity)));
  const tailSubmitReady = Boolean(actionableAssignment && returnedReady && processCountsReady && processCountsWithinReturned);
  const tailReadinessMessage = !returnedReady
    ? "还需完成：返件总数填写为大于 0 的整数"
    : !processCountsReady
      ? "还需完成：每道工序填写整数件数；无返件填 0"
      : !processCountsWithinReturned
        ? "还需完成：单道工序数量不能超过返件总数"
        : "";

  return <div className="mobile-page tail-inspection-page">
    <div className="mobile-hero">
      <div className="mobile-title">
        <h1>尾查报数</h1>
        <StatusBadge tone={actionableAssignment ? "info" : "success"}>N06</StatusBadge>
      </div>
      <p>尾查与工人完工上数并行开始；系统按工序汇总多人清点结果，作为 N07 整单确认的数量基准。</p>
    </div>

    {message ? <p className="tail-inspection-feedback" role="status">{message}</p> : null}

    {data && <Surface>
      <div className="section-title">
        <div>
          <h2>本单尾查进度</h2>
          <p>多人清点时，下方已提交人员的各工序数量会自动相加。</p>
        </div>
        <StatusBadge tone={actionableAssignment ? "warning" : "success"}>{actionableAssignment ? isRoot ? "Root 可代报" : "待本人报数" : isRoot ? "暂无可代报" : "本人已完成"}</StatusBadge>
      </div>
      <div className="tail-inspection-assignment-list">
        {data.assignments.map((assignment) => <div key={assignment.assignmentId}>
          <div><b>{assignment.tailInspectorName}</b><small>{assignment.boxScope ? `清点范围：${assignment.boxScope}` : "未填写箱数或范围"}</small></div>
          <StatusBadge tone={assignment.submittedAt ? "success" : assignment.canSubmit ? "warning" : "info"}>{assignment.submittedAt ? `${assignment.returnedQuantity} 件已提交` : assignment.canSubmit ? isRoot ? "Root 可代清点" : "待本人清点" : "待清点"}</StatusBadge>
        </div>)}
      </div>
    </Surface>}

    {actionableAssignment && data && <Surface className="tail-inspection-entry">
      <div className="section-title">
        <div>
          <h2>{isRoot ? `代 ${actionableAssignment.tailInspectorName} 填写本次清点` : "填写本次清点"}</h2>
          <p>先填返件总数。每个工序默认同步该总数，避免逐项重复输入；按实际分布修改后再提交。</p>
        </div>
        {actionableAssignment.boxScope ? <StatusBadge tone="info">{actionableAssignment.boxScope}</StatusBadge> : null}
      </div>
      <InsetField label="返件总数（件）" type="number" min="1" step="1" inputMode="numeric" value={returnedQuantity} disabled={busy} onChange={(event) => updateReturnedQuantity(event.target.value)} />
      <div className="tail-inspection-processes">
        {data.processes.map((process) => <div className="tail-inspection-process" key={process.configurationItemId}>
          <div><b>{process.processName}</b><small>全部尾查累计：{process.inspectedQuantity} 件</small></div>
          <InsetField label="本次工序数量（件）" type="number" min="0" step="1" inputMode="numeric" value={processQuantities[process.configurationItemId] ?? ""} disabled={busy} onChange={(event) => setProcessQuantities((current) => ({ ...current, [process.configurationItemId]: event.target.value }))} />
        </div>)}
      </div>
      {tailReadinessMessage && <p className="tail-inspection-readiness" role="status">{tailReadinessMessage}</p>}
      <div className="mobile-actions tail-inspection-actions">
        <Button variant="primary" disabled={busy || !tailSubmitReady} onClick={() => void submit()}>{busy ? "提交中…" : isRoot ? "Root 代报尾查数量" : "提交尾查报数"}</Button>
      </div>
    </Surface>}

    {data && !actionableAssignment && submittedAssignments.length === 0 ? <Surface>{isRoot ? "本单暂无可由 Root 代报的尾查任务。" : "本单尚未分配到您的尾查任务。"}</Surface> : null}
  </div>;
}
