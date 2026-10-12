import { createElement } from "react";
import { NAVIGATION_ICON_DATA } from "./navigation-icon-data.js";
import "./navigation-icons.css";

type IconName = keyof typeof NAVIGATION_ICON_DATA;
export const NAVIGATION_ROUTE_ICONS: Readonly<Record<string, IconName>> = {
  "/ui/digital-cockpit": "Activity",
  "/ui/digital-production": "ClipboardPen",
  "/ui/digital-pattern-room": "Shirt",
  "/ui/digital-analysis": "ChartColumn",
  "/ui/my-tasks": "ClipboardCheck",
  "/ui/production-dashboard": "Activity",
  "/ui/production-reporting": "ClipboardPen",
  "/ui/orders": "PackageCheck",
  "/ui/tasks": "Wrench",
  "/ui/reports": "ChartColumn",
  "/ui/wages": "Wallet",
  "/ui/finance": "Wallet",
  "/ui/pattern-room": "Shirt",
  "/ui/pattern-room/orders": "ClipboardCheck",
  "/ui/pattern-room/create": "FilePlus2",
  "/ui/pattern-room/prices": "Wallet",
  "/ui/sourcing/create": "FilePlus2",
  "/ui/sourcing/pending": "FileText",
  "/ui/sourcing/history": "History",
  "/ui/cutting": "ClipboardCheck",
  "/ui/suppliers": "Factory",
  "/ui/suppliers/manage": "FilePenLine",
  "/ui/samples": "Shirt",
  "/ui/samples/pending": "CircleCheck",
  "/ui/samples/disposed": "Archive",
  "/ui/samples/amounts": "ChartColumn",
  "/ui/employee-access": "Users",
  "/ui/admin": "Settings",
  "/ui/master-data": "Factory",
  "/ui/people": "Users",
};

export const NAVIGATION_GROUP_ICONS: Readonly<Record<string, IconName>> = {
  "设计师创建订单": "FilePlus2", "产品开发打板": "Shirt", "大货产前准备": "ClipboardCheck", "裁后工艺与发厂": "Factory", "生产填报": "ClipboardPen", "订单打板": "Shirt", "样衣管理": "Shirt", "订单返工": "Wrench", "外发定价&选厂": "FileText", "订单开裁": "ClipboardCheck",
  "供应商中心": "Factory", "财务中心": "Wallet", "平台管理": "Settings", "更多": "Ellipsis", "实时生产看板": "Activity",
};

// Exact route matches only: an unknown page must not acquire another page's icon.
export function navigationIconForRoute(route: string): IconName | undefined {
  const path = route.split(/[?#]/, 1)[0]?.replace(/\/$/, "") ?? "";
  return NAVIGATION_ROUTE_ICONS[path];
}

export function NavigationIcon({ route, group, name:explicitName, size = "secondary" }: {
  route?: string; group?: string; name?:IconName;size?: "primary" | "secondary" | "title";
}) {
  const name = explicitName??(route ? navigationIconForRoute(route) : undefined) ?? (group ? NAVIGATION_GROUP_ICONS[group] : undefined);
  if (!name) return null;
  return <svg className={`dx-navigation-icon dx-navigation-icon--${size}`} viewBox="0 0 24 24"
    fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
    aria-hidden="true" focusable="false">
    {NAVIGATION_ICON_DATA[name].map(([tag, attributes], index) => createElement(tag, { ...attributes, key: index }))}
  </svg>;
}
