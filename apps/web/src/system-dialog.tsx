import { Button } from "@dx-rework/ui";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Button as AstryxButton } from "@astryxdesign/core/Button";
import { Dialog } from "@astryxdesign/core/Dialog";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { createRoot, type Root } from "react-dom/client";
import { designerAstryxCss } from "./designer-astryx.js";

import "./system-dialog.css";

type DialogOptions = Readonly<{
  title?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  className?: string;
  presentation?: "astryx";
}>;

type PromptOptions = DialogOptions & Readonly<{
  requiredMessage?: string;
}>;

type ConfirmRequest = Readonly<{
  kind: "confirm";
  message: string;
  options: DialogOptions;
  resolve: (value: boolean) => void;
}>;

type PromptRequest = Readonly<{
  kind: "prompt";
  message: string;
  defaultValue: string;
  options: PromptOptions;
  resolve: (value: string | null) => void;
}>;

type AlertRequest = Readonly<{
  kind: "alert";
  message: string;
  options: DialogOptions;
  resolve: () => void;
}>;

export type BusinessDialogIssue = Readonly<{
  type: "missing" | "format" | "prerequisite" | "permission" | "version" | "upload" |
    "read" | "failure" | "unknown" | "read-after-success";
  message: string;
  field?: Readonly<{ id: string; label: string }>;
}>;
type BusinessRequest = Readonly<{
  kind: "business-error";
  action: string;
  issues: readonly BusinessDialogIssue[];
  resolve: (field: string | null) => void;
}>;
type DialogRequest = ConfirmRequest | PromptRequest | AlertRequest | BusinessRequest;

const queue: DialogRequest[] = [];
let active = false;

const completeRequest = (
  request: DialogRequest,
  value: boolean | string | null,
  root: Root,
  host: HTMLDivElement,
  trigger: HTMLElement | null,
): void => {
  queueMicrotask(() => {
    host.querySelector<HTMLDialogElement>("dialog[open]")?.close();
    root.unmount();
    host.remove();
    if (trigger?.isConnected) trigger.focus({ preventScroll: true });
    active = false;
    if (request.kind === "confirm") {
      request.resolve(value === true);
    } else if (request.kind === "prompt" || request.kind === "business-error") {
      request.resolve(typeof value === "string" ? value : null);
    } else {
      request.resolve();
    }
    mountNextDialog();
  });
};

const mountNextDialog = (): void => {
  if (active || queue.length === 0 || typeof document === "undefined") return;
  active = true;
  const request = queue.shift()!;
  const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const host = document.createElement("div");
  host.dataset.systemDialogHost = "true";
  // A native modal makes body siblings inert. Keep its confirmation usable in the same top layer.
  ([...document.querySelectorAll<HTMLDialogElement>("dialog:modal")].at(-1) ?? document.body).append(host);
  const root = createRoot(host);
  let completed = false;
  const finish = (value: boolean | string | null): void => {
    if (completed) return;
    completed = true;
    completeRequest(request, value, root, host, trigger);
  };
  if (request.kind === "business-error" || (request.kind !== "prompt" && request.options.presentation === "astryx")) {
    host.classList.add("dx-designer-astryx");
    host.lang = "zh-CN";
    root.render(<><style>{designerAstryxCss}</style>{request.kind === "business-error"
      ? <BusinessDialog request={request} onComplete={finish} />
      : <AstryxNotice request={request} onComplete={finish} />}</>);
    return;
  }
  root.render(<SystemDialog request={request} onComplete={finish} />);
};

export const businessErrorInApp = (action: string, issues: readonly BusinessDialogIssue[]): Promise<string | null> => {
  if (typeof document === "undefined" || !issues.length) return Promise.resolve(null);
  return new Promise(resolve => {
    queue.push({ kind: "business-error", action, issues, resolve });
    mountNextDialog();
  });
};

export const confirmInApp = (
  message: string,
  options: DialogOptions = {},
): Promise<boolean> => {
  if (typeof document === "undefined") return Promise.resolve(false);
  return new Promise((resolve) => {
    queue.push({ kind: "confirm", message, options, resolve });
    mountNextDialog();
  });
};

export const alertInApp = (
  message: string,
  options: DialogOptions = {},
): Promise<void> => {
  if (typeof document === "undefined") return Promise.resolve();
  return new Promise((resolve) => {
    queue.push({ kind: "alert", message, options, resolve });
    mountNextDialog();
  });
};

export const promptInApp = (
  message: string,
  defaultValue = "",
  options: PromptOptions = {},
): Promise<string | null> => {
  if (typeof document === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    queue.push({ kind: "prompt", message, defaultValue, options, resolve });
    mountNextDialog();
  });
};

function AstryxNotice({request,onComplete}:{
  request: ConfirmRequest | AlertRequest;
  onComplete: (value: boolean) => void;
}) {
  const { options, message } = request;
  return <AlertDialog isOpen title={options.title ?? (request.kind === "confirm" ? "确认操作" : "操作提示")}
    description={message} actionLabel={options.confirmLabel ?? (request.kind === "confirm" ? "确认" : "知道了")}
    cancelLabel={options.cancelLabel ?? (request.kind === "confirm" ? "取消" : "关闭")}
    actionVariant="primary" onAction={() => onComplete(true)}
    onOpenChange={open => { if (!open) onComplete(false); }}
    data-system-dialog-kind={request.kind} className={options.className} />;
}

function BusinessDialog({request,onComplete}:{
  request: BusinessRequest;
  onComplete: (field: string | null) => void;
}) {
  const titleId = useId();
  const labels: Record<BusinessDialogIssue["type"],string> = {
    missing: "缺项", format: "格式", prerequisite: "业务前置", permission: "权限",
    version: "版本", upload: "上传", read: "读取", failure: "未能完成",
    unknown: "结果待确认", "read-after-success": "已提交，读取待恢复",
  };
  return <Dialog isOpen purpose="form" aria-labelledby={titleId}
    onOpenChange={open => { if (!open) onComplete(null); }} width="min(32rem, calc(100vw - 2rem))"
    data-system-dialog-kind="business-error">
    <div className="system-dialog-issues">
      <h2 id={titleId}>{request.action}</h2>
      <ul>{request.issues.map(({type,message,field},index) => <li key={`${field?.id ?? type}-${index}`}>
        <span>{labels[type]} · {message}</span>
        {field && <AstryxButton type="button" size="sm" variant="secondary" label="去填写"
          aria-label={`去填写 ${field.label}`} onClick={() => onComplete(field.id)} />}
      </li>)}</ul>
      <AstryxButton type="button" size="sm" variant="secondary" label="关闭" onClick={() => onComplete(null)} />
    </div>
  </Dialog>;
}

function SystemDialog({
  request,
  onComplete,
}: {
  request: ConfirmRequest | PromptRequest | AlertRequest;
  onComplete: (value: boolean | string | null) => void;
}) {
  const titleId = useId();
  const messageId = useId();
  const errorId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(request.kind === "prompt" ? request.defaultValue : "");
  const [error, setError] = useState("");
  const title = request.options.title
    ?? (request.kind === "prompt" ? "填写信息" : request.kind === "alert" ? "操作提示" : "确认操作");
  const confirmLabel = request.options.confirmLabel ?? (request.kind === "alert" ? "知道了" : "确认");
  const cancelLabel = request.options.cancelLabel ?? "取消";

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const frame = window.requestAnimationFrame(() => {
      if (request.kind === "prompt") {
        inputRef.current?.focus();
        inputRef.current?.select();
      } else {
        document.querySelector<HTMLButtonElement>("[data-system-dialog-confirm='true']")?.focus();
      }
    });
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onComplete(request.kind === "confirm" ? false : request.kind === "prompt" ? null : true);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [onComplete, request.kind]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (request.kind === "prompt" && request.options.requiredMessage && !value.trim()) {
      setError(request.options.requiredMessage);
      inputRef.current?.focus();
      return;
    }
    onComplete(request.kind === "prompt" ? value : true);
  };

  return (
    <div className="system-dialog-backdrop" role="presentation">
      <section
        className={'system-dialog'+(request.options.className?' '+request.options.className:'')}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={messageId}
        data-system-dialog-kind={request.kind}
      >
        <form onSubmit={submit}>
          <div className="system-dialog__copy">
            <h2 id={titleId}>{title}</h2>
            <p id={messageId}>{request.message}</p>
          </div>
          {request.kind === "prompt" ? (
            <label className="system-dialog__field">
              <span>输入内容</span>
              <input
                ref={inputRef}
                aria-label={request.message}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? errorId : undefined}
                data-system-dialog-input="true"
                value={value}
                onChange={(event) => {
                  setValue(event.target.value);
                  if (event.target.value.trim()) setError("");
                }}
              />
              {error ? <span id={errorId} className="system-dialog__error" role="alert">{error}</span> : null}
            </label>
          ) : null}
          <div className="system-dialog__actions">
            {request.kind !== "alert" ? <Button
              type="button"
              data-system-dialog-cancel="true"
              onClick={() => onComplete(request.kind === "confirm" ? false : null)}
            >
              {cancelLabel}
            </Button> : null}
            <Button type="submit" variant="primary" data-system-dialog-confirm="true">
              {confirmLabel}
            </Button>
          </div>
        </form>
      </section>
    </div>
  );
}
