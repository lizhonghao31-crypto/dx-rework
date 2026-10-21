import { useEffect, useState } from "react";

import { Button,StatusBadge, Surface } from "@dx-rework/ui";

import { createWebUrls } from "../url-contract.js";
import {
  PRODUCTION_COMMAND_CENTER_DEMO_ORDERS,
  PRODUCTION_COMMAND_CENTER_DEMO_SELECTED,
  PRODUCTION_COMMAND_CENTER_DEMO_SUMMARY,
} from "./production-command-center-demo-data.js";
import { ProductionCommandCenterView } from "./production-command-center-view.js";
import "./acceptance-production-command-center-page.css";

const { apiUrl } = createWebUrls(import.meta.env.BASE_URL);

type Availability = "checking" | "available" | "unavailable" | "failed";

export function AcceptanceProductionCommandCenterPage() {
  const [availability, setAvailability] = useState<Availability>("checking");

  const [readAttempt,setReadAttempt]=useState(0);
  useEffect(() => {
    setAvailability("checking");
    const controller = new AbortController();
    void fetch(apiUrl("acceptance/control/status"), {
      credentials: "include",
      cache: "no-store",
      signal: controller.signal,
    }).then((response) => {
      if (response.status === 200 || response.status === 401) {
        setAvailability("available");
        return;
      }
      setAvailability(response.status===404?"unavailable":"failed");
    }).catch(() => {
      if (!controller.signal.aborted) setAvailability("failed");
    });
    return () => controller.abort();
  }, [readAttempt]);

  if (availability === "checking") {
    return <main className="acceptance-command-center-state"><Surface><p role="status">正在核对 Acceptance 视觉验收环境…</p></Surface></main>;
  }

  if(availability==="failed")return <main className="acceptance-command-center-state"><Surface><p role="alert">验收环境状态尚未读取，不能据此判断页面是否启用；请重新读取，仍失败时请管理员核查。</p><Button onClick={()=>setReadAttempt(value=>value+1)}>仅重新读取验收状态</Button></Surface></main>;

  if (availability === "unavailable") {
    return <main className="acceptance-command-center-state"><Surface>
      <StatusBadge tone="warning">Acceptance Only</StatusBadge>
      <h1>生产管理座舱视觉验收页未启用</h1>
      <p>该页面只在明确启用 Acceptance Lab 的独立验收环境展示；正式生产站点不提供此视觉样板。</p>
    </Surface></main>;
  }

  return <div className="acceptance-command-center-preview" data-acceptance-command-center-ready="true">
    <div className="acceptance-command-center-preview__notice">
      <StatusBadge tone="info">Acceptance 视觉验收</StatusBadge>
      <span>当前为固定演示数据，仅用于核对真实 React 页面布局，不代表正式业务数据。</span>
    </div>
    <ProductionCommandCenterView
      summary={PRODUCTION_COMMAND_CENTER_DEMO_SUMMARY}
      orders={PRODUCTION_COMMAND_CENTER_DEMO_ORDERS}
      selectedOrderNo={PRODUCTION_COMMAND_CENTER_DEMO_SELECTED}
    />
  </div>;
}
