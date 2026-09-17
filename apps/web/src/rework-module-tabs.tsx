import { createWebUrls } from "../url-contract.js";
import "./rework-data-sandbox.css";

const { pageUrl } = createWebUrls(import.meta.env.BASE_URL);

export function ReworkModuleTabs({ active }: { active: "board" | "sandbox" }) {
  return <nav className="rework-module-tabs" aria-label="订单返工二级模块">
    <a className={active === "board" ? "is-active" : ""} href={pageUrl("ui/tasks")}>返工单看板</a>
    <a className={active === "sandbox" ? "is-active" : ""} href={pageUrl("ui/tasks?view=sandbox")}>数据沙盘</a>
  </nav>;
}
