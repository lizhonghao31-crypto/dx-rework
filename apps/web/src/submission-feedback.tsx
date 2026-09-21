import { useEffect, useRef, useState } from "react";
import { alertInApp } from "./system-dialog.js";
import type { SubmissionIssue } from "./submission-validation.js";
import { SubmissionAttempt } from "./submission-attempt.js";
import "./submission-feedback.css";

export function focusSubmissionField(id: string): void {
  const field = document.getElementById(id);
  if (!field) return;
  for (let parent = field.parentElement; parent; parent = parent.parentElement) {
    if (parent instanceof HTMLDetailsElement) parent.open = true;
  }
  field.focus({ preventScroll: true });
  field.scrollIntoView({ block: "center", behavior: "auto" });
}

export function useSubmissionFeedback(setBusy: (busy: boolean) => void) {
  const [issues, setIssues] = useState<readonly SubmissionIssue[]>([]);
  const [uncertain, setUncertain] = useState(false);
  const [notice, setNotice] = useState("");
  const locked = useRef(false);
  const attempt = useRef(new SubmissionAttempt());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    const warn = (event: BeforeUnloadEvent) => {
      if (!attempt.current.hasPending) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => { mounted.current = false; window.removeEventListener("beforeunload", warn); };
  }, []);

  const reject = async (next: readonly SubmissionIssue[]): Promise<void> => {
    if (locked.current || !next.length) return;
    locked.current = true;
    setIssues(next);
    try {
      await alertInApp(next.map((issue, index) => `${index + 1}. ${issue.message}`).join("\n"), {
        title: "请先完善以下资料", confirmLabel: "去修改",
      });
      if (mounted.current && next[0]) focusSubmissionField(next[0].fieldId);
    } finally { locked.current = false; }
  };

  const perform = async (execute: () => Promise<void>, retry: boolean): Promise<void> => {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setIssues([]);
    setNotice("");
    try {
      const outcome = retry ? await attempt.current.retry() : await attempt.current.run(execute);
      if (!mounted.current) return;
      if (outcome.kind === "needs-recovery" || outcome.kind === "expired") {
        await alertInApp(outcome.kind === "expired"
          ? "上次提交已超过安全重试时限，请联系管理员核查原单；不要重新提交。"
          : "上次提交结果尚未确认。请先点击“核对上次提交结果”，不要重新创建或重复办理。", { title: "提交结果待确认" });
      } else if (outcome.kind === "success") setUncertain(false);
      else if (outcome.kind === "failure") {
        const { failure, uncertain: unknown, confirmed } = outcome;
        setUncertain(unknown);
        const message = confirmed ? "提交已成功，但页面更新未完成，请刷新查看原单，不要重复办理。" : unknown
          ? `${failure.message}\n提交可能已经成功。已保留原请求，请核对上次提交结果；不要刷新、离开或新建重复订单。`
          : failure.message;
        setNotice(message);
        if (!failure.cancelled) await alertInApp(message, { title: unknown ? "提交结果待确认" : failure.title });
      }
    } finally {
      locked.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  return {
    issues, uncertain, notice, reject,
    confirmed: () => { attempt.current.markConfirmed(); if (mounted.current) setUncertain(false); },
    run: (execute: () => Promise<void>) => perform(execute, false),
    retry: () => perform(() => Promise.resolve(), true),
    field: (id: string) => ({ id, ...(issues.some(issue => issue.fieldId === id)
      ? { "aria-invalid": true as const, "aria-describedby": `${id}-submission-error` } : {}) }),
  };
}

export function SubmissionFeedback({ feedback, busy }: {
  feedback: ReturnType<typeof useSubmissionFeedback>; busy: boolean;
}) {
  return <>
    {feedback.issues.length ? <section className="submission-feedback" aria-label="待修改资料" role="alert">
      <strong>请完善以下资料后重新提交</strong>
      <ul>{feedback.issues.map(issue => <li key={issue.fieldId} id={`${issue.fieldId}-submission-error`}>
        <button type="button" onClick={() => focusSubmissionField(issue.fieldId)}>{issue.message} · 去修改</button>
      </li>)}</ul>
    </section> : null}
    {feedback.notice ? <p className="submission-feedback" role="status">{feedback.notice}</p> : null}
    {feedback.uncertain ? <button className="dx-button dx-button--primary" type="button" disabled={busy}
      onClick={() => void feedback.retry()}>{busy ? "正在核对…" : "核对上次提交结果"}</button> : null}
  </>;
}
