import { DigitalProductionEntry } from "./digital-production-page.js";
import { StatusBadge, Surface } from "@dx-rework/ui";
import { useEffect, useState } from "react";

import { verifySession, type AuthorizedUser } from "./auth.js";
import { accessiblePlatformModules, platformModuleHref } from "./platform-modules.js";
import "./platform-home.css";

const ROLE_LABELS: Record<string, string> = {
  cutting_supervisor: "裁床主管",
  cutting_worker: "裁床工人",
  owner_group: "老板",
  production_management: "供应链总监",
  development_clerk: "开发文员",
  pattern_room_tail_inspector: "板房尾查",
  order_merchandiser: "订单跟单",
  factory_payables: "加工厂应付会计",
  finance_director: "财务总监",
};

const moduleCopy = {
  digital: {title: "生产管理座舱", description: "数字开发与大货进度、原单办理和板房数据沙盘"},
  pattern_room: { title: "订单打板", description: "打板与杂事请求、板房价格管控" },
  finance: { title: "财务中心", description: "工资查询、导出与发放标记" },
  samples: { title: "样衣管理", description: "查看在管样衣、待确认事项、处置与库存金额" },
  production: { title: "实时生产看板", description: "查看生产订单，按负责范围上报生产、完成和发货" },
  sourcing: {
    title: "外发定价&选厂",
    description: "创建询价、主管决定工厂和单价、合同执行与财务核对",
  },
  cutting: {
    title: "订单开裁",
    description: "裁床实裁数量登记与回看",
  },
  rework: {
    title: "订单返工",
    description: "收货、返工处理、责任判定、工资与扣款",
  },
  suppliers: {
    title: "供应商中心",
    description: "检索供应商目录、维护基础与合同资料、核对版本变更",
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
          <p className="platform-home__eyebrow">达兴 · 数字助手</p>
          <h1>业务工作台</h1>
          <p>请选择需要进入的业务模块</p>
        </div>
        <Surface className="platform-home__identity">
          <strong>{user.displayName}</strong>
          <span>{roles}</span>
          <StatusBadge tone="success">组织内已认证</StatusBadge>
        </Surface>
      </header>
      <DigitalProductionEntry />
      <section className="platform-home__modules" aria-label="可访问业务模块">
        {modules.map((module) => (
          <Surface className="platform-home__module" key={module.id}>
            <StatusBadge tone="info">业务模块</StatusBadge>
            <h2>{moduleCopy[module.id].title}</h2>
            <p>{moduleCopy[module.id].description}</p>
            <a className="dx-button dx-button--primary platform-home__action" href={`${basePath}/${platformModuleHref(module)}`}>进入模块</a>
          </Surface>
        ))}
      </section>
    </main>
  );
}
