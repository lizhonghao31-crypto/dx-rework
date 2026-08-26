import { StatusBadge, Surface } from "@dx-rework/ui";
import { useEffect, useState } from "react";

import { verifySession, type AuthorizedUser } from "./auth.js";
import { accessiblePlatformModules } from "./platform-modules.js";
import "./platform-home.css";

const ROLE_LABELS: Record<string, string> = {
  owner_group: "老板",
  production_management: "生产管理",
  order_merchandiser: "订单跟单",
  factory_payables: "加工厂应付会计",
  finance_director: "财务总监",
};

const moduleCopy = {
  sourcing: {
    title: "报价&选厂",
    description: "创建询价、主管决定工厂和单价、合同执行与财务核对",
  },
  rework: {
    title: "尾部返工",
    description: "收货、返工处理、责任判定、工资与扣款",
  },
} as const;

export function PlatformHomePage() {
  const [user, setUser] = useState<AuthorizedUser | null>(null);

  useEffect(() => {
    let mounted = true;
    void verifySession().then((session) => {
      if (mounted && session !== "denied" && session.status === "authorized") setUser(session.user);
    });
    return () => { mounted = false; };
  }, []);

  if (!user) return null;
  const modules = accessiblePlatformModules(user);
  const roles = user.businessRoles?.map((role) => ROLE_LABELS[role] ?? role).join(" · ") || "已登录";
  const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

  return (
    <main className="platform-home">
      <header className="platform-home__header">
        <div>
          <p className="platform-home__eyebrow">达兴 · 业务平台</p>
          <h1>业务工作台</h1>
          <p>请选择需要进入的业务模块</p>
        </div>
        <Surface className="platform-home__identity">
          <strong>{user.displayName}</strong>
          <span>{roles}</span>
          <StatusBadge tone="success">组织内已认证</StatusBadge>
        </Surface>
      </header>
      <section className="platform-home__modules" aria-label="可访问业务模块">
        {modules.map((module) => (
          <Surface className="platform-home__module" key={module.id}>
            <StatusBadge tone="info">业务模块</StatusBadge>
            <h2>{moduleCopy[module.id].title}</h2>
            <p>{moduleCopy[module.id].description}</p>
            <a className="dx-button dx-button--primary platform-home__action" href={`${basePath}/${module.href}`}>进入模块</a>
          </Surface>
        ))}
      </section>
    </main>
  );
}
