import { useEffect, useState } from "react";

import { VersionResponseSchema, type VersionResponse } from "@dx-rework/contracts";

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; version: VersionResponse }
  | { kind: "unavailable" };

export function App() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/version", { signal: controller.signal, headers: { accept: "application/json" } })
      .then(async (response) => {
        if (!response.ok) throw new Error("Version endpoint unavailable");
        return VersionResponseSchema.parse(await response.json());
      })
      .then((version) => setState({ kind: "ready", version }))
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          setState({ kind: "unavailable" });
        }
      });
    return () => controller.abort();
  }, []);

  return (
    <main className="foundation-shell">
      <section className="foundation-card" aria-labelledby="foundation-title">
        <p className="eyebrow">PR-01 · TECHNICAL FOUNDATION</p>
        <h1 id="foundation-title">内部计件返工系统</h1>
        <p className="summary">
          当前页面仅用于验证独立前端、API 与版本追踪链路。经业务验收的混合工业风页面将在 PR-01A 按 Figma Golden Source 落地。
        </p>
        <dl className="status-grid">
          <div>
            <dt>前端</dt>
            <dd>独立运行</dd>
          </div>
          <div>
            <dt>API</dt>
            <dd>{state.kind === "loading" ? "检查中" : state.kind === "ready" ? "可访问" : "未连接"}</dd>
          </div>
          <div>
            <dt>Git SHA</dt>
            <dd>{state.kind === "ready" ? state.version.gitSha.slice(0, 12) : "—"}</dd>
          </div>
          <div>
            <dt>Schema</dt>
            <dd>{state.kind === "ready" ? (state.version.schemaVersion ?? "未迁移") : "—"}</dd>
          </div>
        </dl>
        <p className="boundary-note">不连接 ERP · 不启用钉钉 · 不写入生产数据</p>
      </section>
    </main>
  );
}
