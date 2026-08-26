import { StatusBadge, Surface } from "@dx-rework/ui";

import "./sourcing-shell.css";

export function SourcingShellPage() {
  const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
  return (
    <main className="sourcing-shell">
      <Surface className="sourcing-shell__card">
        <StatusBadge tone="info">达兴 · 业务平台</StatusBadge>
        <h1>报价&选厂工作台</h1>
        <p>报价与选厂业务功能正在建设中</p>
        <a className="dx-button dx-button--secondary" href={`${basePath}/ui/home`}>返回业务工作台</a>
      </Surface>
    </main>
  );
}
