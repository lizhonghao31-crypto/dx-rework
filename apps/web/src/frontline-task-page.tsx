import { LogoutButton } from "./session-exit.js";
import {
  FrontlineTasksResponseSchema,
  type FrontlineTaskItem,
  type FrontlineTaskKind,
} from "@dx-rework/contracts";
import { StatusBadge, Surface } from "@dx-rework/ui";
import { useEffect, useMemo, useState } from "react";

import { createWebUrls } from "../url-contract.js";
import { ListPagination, usePaginatedItems } from "./list-pagination.js";
import { WorkReportingForm } from "./work-reporting-form.js";
import "./frontline-task-page.css";

const { apiUrl, pageUrl } = createWebUrls(import.meta.env.BASE_URL);
const imageUrl = (attachmentId: string): string =>
  apiUrl(`tools/attachments/${attachmentId}/download?mode=preview`);

type State =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "ready"; items: readonly FrontlineTaskItem[] }>
  | Readonly<{ kind: "error"; message: string }>;

const requestedKind = (): FrontlineTaskKind | null => {
  const value = new URLSearchParams(window.location.search).get("kind");
  return value === "worker" || value === "tail_inspection" ? value : null;
};

export function FrontlineTaskPage() {
  const kind = useMemo(requestedKind, []);
  const [state, setState] = useState<State>({ kind: "loading" });
  const [selectedId, setSelectedId] = useState<string | null>(
    () => new URLSearchParams(window.location.search).get("rework"),
  );

  useEffect(() => {
    if (!kind) {
      setState({ kind: "error", message: "任务类型无效，请返回一线工作台重新进入。" });
      return;
    }
    const controller = new AbortController();
    void fetch(apiUrl(`frontline/work-tasks?kind=${kind}`), {
      credentials: "include",
      cache: "no-store",
      signal: controller.signal,
      headers: { accept: "application/json" },
    }).then(async (response) => {
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
        throw new Error(body?.error?.message ?? "本人任务读取失败，请稍后重试。");
      }
      const result = FrontlineTasksResponseSchema.parse(await response.json());
      setState({ kind: "ready", items: result.items });
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) {
        setState({ kind: "error", message: error instanceof Error ? error.message : "本人任务读取失败，请稍后重试。" });
      }
    });
    return () => controller.abort();
  }, [kind]);

  const items = state.kind === "ready" ? state.items : [];
  const page = usePaginatedItems(items, kind ?? "");
  const selected = items.find((item) => item.reworkOrderId === selectedId)
    ?? (items.length === 1 ? items[0] : null);

  const enter = (item: FrontlineTaskItem) => {
    setSelectedId(item.reworkOrderId);
    const url = new URL(window.location.href);
    url.searchParams.set("rework", item.reworkOrderId);
    window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
  };

  const exit = () => {
    if (items.length === 1) {
      window.location.href = pageUrl("ui/frontline");
      return;
    }
    setSelectedId(null);
    const url = new URL(window.location.href);
    url.searchParams.delete("rework");
    window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
  };

  if (selected && kind) {
    return <main className="frontline-task-workspace"><div className="frontline-session-exit"><LogoutButton /></div>
      {selected.images.length > 0 ? <section className="frontline-task-images" aria-label="订单图片">
        <strong>订单图片</strong>
        <div>
          {selected.images.map((image) => <a href={imageUrl(image.attachmentId)} target="_blank" rel="noreferrer" key={image.attachmentId}>
            <img src={imageUrl(image.attachmentId)} alt={image.filename} loading="lazy" />
          </a>)}
        </div>
      </section> : null}
      <WorkReportingForm
        reworkOrderId={selected.reworkOrderId}
        taskMode="work_reporting"
        frontlineContext={{
          kind,
          reworkNo: selected.reworkNo,
          styleNo: selected.styleNo,
          processNames: selected.processNames,
        }}
        onFrontlineExit={exit}
      />
    </main>;
  }

  return <main className="frontline-task-page"><div className="frontline-session-exit"><LogoutButton /></div>
    <header>
      <StatusBadge tone="info">{kind === "tail_inspection" ? "本人整查任务" : "本人返工任务"}</StatusBadge>
      <h1>{kind === "tail_inspection" ? "待整查报数" : "待完工上数"}</h1>
      <p>只显示分配给本人且尚未报数的当前任务。</p>
    </header>
    {state.kind === "loading" ? <Surface>正在读取本人任务…</Surface> : null}
    {state.kind === "error" ? <Surface>{state.message}</Surface> : null}
    {state.kind === "ready" && items.length === 0 ? <Surface>当前没有需要本人处理的任务。</Surface> : null}
    {state.kind === "ready" && items.length > 1 ? <div className="frontline-task-list">
      {page.items.map((item) => <button className={item.images[0] ? "has-image" : undefined} type="button" onClick={() => enter(item)} key={item.reworkOrderId}>
        <span className="frontline-task-list__identity"><small>款号</small><strong>{item.styleNo ?? "款号未填写"}</strong><small>{item.reworkNo ?? "返工单号待生成"}</small></span>
        {item.images[0] ? <img className="frontline-task-list__image" src={imageUrl(item.images[0].attachmentId)} alt={item.images[0].filename} loading="lazy" /> : null}
        <span><small>工序</small><strong>{item.processNames.join("、")}</strong></span>
        <StatusBadge tone="warning">{kind === "tail_inspection" ? "待整查报数" : "待完工上数"}</StatusBadge>
        <b>进入</b>
      </button>)}
    </div> : null}
    {state.kind === "ready" && items.length > 1 ? <ListPagination page={page.page} totalPages={page.totalPages} onPageChange={page.setPage} ariaLabel="本人任务分页" /> : null}
    <a className="frontline-task-back" href={pageUrl("ui/frontline")}>返回一线工作台</a>
  </main>;
}
