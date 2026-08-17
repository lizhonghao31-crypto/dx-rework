import { Button } from "@dx-rework/ui";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { createRoot, type Root } from "react-dom/client";

import "./system-dialog.css";

type DialogOptions = Readonly<{
  title?: string;
  confirmLabel?: string;
  cancelLabel?: string;
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
  options: DialogOptions;
  resolve: (value: string | null) => void;
}>;

type DialogRequest = ConfirmRequest | PromptRequest;

const queue: DialogRequest[] = [];
let active = false;

const completeRequest = (
  request: DialogRequest,
  value: boolean | string | null,
  root: Root,
  host: HTMLDivElement,
): void => {
  queueMicrotask(() => {
    root.unmount();
    host.remove();
    active = false;
    if (request.kind === "confirm") {
      request.resolve(value === true);
    } else {
      request.resolve(typeof value === "string" ? value : null);
    }
    mountNextDialog();
  });
};

const mountNextDialog = (): void => {
  if (active || queue.length === 0 || typeof document === "undefined") return;
  active = true;
  const request = queue.shift()!;
  const host = document.createElement("div");
  host.dataset.systemDialogHost = "true";
  document.body.append(host);
  const root = createRoot(host);
  let completed = false;
  const finish = (value: boolean | string | null): void => {
    if (completed) return;
    completed = true;
    completeRequest(request, value, root, host);
  };
  root.render(<SystemDialog request={request} onComplete={finish} />);
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

export const promptInApp = (
  message: string,
  defaultValue = "",
  options: DialogOptions = {},
): Promise<string | null> => {
  if (typeof document === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    queue.push({ kind: "prompt", message, defaultValue, options, resolve });
    mountNextDialog();
  });
};

function SystemDialog({
  request,
  onComplete,
}: {
  request: DialogRequest;
  onComplete: (value: boolean | string | null) => void;
}) {
  const titleId = useId();
  const messageId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(request.kind === "prompt" ? request.defaultValue : "");
  const title = request.options.title ?? (request.kind === "prompt" ? "填写信息" : "确认操作");
  const confirmLabel = request.options.confirmLabel ?? "确认";
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
      onComplete(request.kind === "confirm" ? false : null);
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
    onComplete(request.kind === "confirm" ? true : value);
  };

  return (
    <div className="system-dialog-backdrop" role="presentation">
      <section
        className="system-dialog"
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
                data-system-dialog-input="true"
                value={value}
                onChange={(event) => setValue(event.target.value)}
              />
            </label>
          ) : null}
          <div className="system-dialog__actions">
            <Button
              type="button"
              data-system-dialog-cancel="true"
              onClick={() => onComplete(request.kind === "confirm" ? false : null)}
            >
              {cancelLabel}
            </Button>
            <Button type="submit" variant="primary" data-system-dialog-confirm="true">
              {confirmLabel}
            </Button>
          </div>
        </form>
      </section>
    </div>
  );
}
