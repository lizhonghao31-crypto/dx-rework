import { useEffect, useState } from "react";
import { Button, Surface } from "@dx-rework/ui";
import { canUsePatternOrder } from "@dx-rework/contracts/pattern-orders";
import { Header } from "./components.js";
import { verifySession } from "./auth.js";
import { PatternOrderForm } from "./pattern-order-form.js";
import { patternUrls } from "./pattern-order-client.js";
import "./pattern-room.css";

export function PatternOrderCreatePage() {
  const [allowed, setAllowed] = useState<{ pattern: boolean; misc: boolean } | null>(null);
  const [kind, setKind] = useState<"pattern" | "misc">(new URLSearchParams(window.location.search).get("kind") === "misc" ? "misc" : "pattern");
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    void verifySession().then(session => {
      if (!live) return;
      if (session === "denied") { setError("请重新登录"); return; }
      const user = session.user;
      const pattern = user.isRoot === true || canUsePatternOrder(user.businessRoles ?? [], user.capabilities, "pattern_room:orders:create");
      const misc = user.isRoot === true || canUsePatternOrder(user.businessRoles ?? [], user.capabilities, "pattern_room:misc:create");
      setAllowed({ pattern, misc });
      if (!pattern && misc) setKind("misc");
      if (!pattern && !misc) setError("当前账号没有创建订单权限");
    }).catch(() => { if (live) setError("读取创建权限失败，请刷新重试"); });
    return () => { live = false; };
  }, []);
  return <div className="pattern-orders"><Header title="创建订单" badge="订单打板" badgePlacement="subtitle" />
    {error ? <Surface><p role="alert">{error}</p></Surface> : !allowed ? <p role="status">正在读取…</p> : <>
      <div className="pattern-kind" role="group" aria-label="创建订单类型">{allowed.pattern && <Button aria-pressed={kind === "pattern"} variant={kind === "pattern" ? "primary" : "secondary"} onClick={() => setKind("pattern")}>打板</Button>}{allowed.misc && <Button aria-pressed={kind === "misc"} variant={kind === "misc" ? "primary" : "secondary"} onClick={() => setKind("misc")}>杂事</Button>}</div>
      <PatternOrderForm key={kind} kind={kind} onCancel={() => window.location.assign(patternUrls.pageUrl("ui/pattern-room/orders"))} onSaved={order => window.location.assign(patternUrls.pageUrl(`ui/pattern-room/orders/${order.orderId}`))} />
    </>}
  </div>;
}
