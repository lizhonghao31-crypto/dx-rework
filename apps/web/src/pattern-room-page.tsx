import { DigitalProductionEntry } from "./digital-production-page.js";
import { Surface } from "@dx-rework/ui";
import { Header } from "./components.js";
import { patternUrls } from "./pattern-order-client.js";
import { useEffect, useState } from "react";
import { verifySession, type AuthorizedUser } from "./auth.js";
import { canAccessPatternRoomPrices, canAccessPatternRoomOrders, canCreatePatternRoomOrders } from "./pattern-room-access.js";
import { useInternalReturnScroll } from "./use-internal-return-scroll.js";
export function PatternRoomPage() {
  const [user, setUser] = useState<AuthorizedUser | null>(null);
  useInternalReturnScroll(user !== null);
  useEffect(() => { let live = true; void verifySession().then(session => { if (live && session !== "denied") setUser(session.user); }).catch(() => undefined); return () => { live = false; }; }, []);
  return <div className="pattern-orders"><Header title="订单打板" badge="板房" badgePlacement="subtitle" />{user && <Surface><div className="pattern-actions">
    {canAccessPatternRoomOrders(user) && <a className="dx-button dx-button--primary" href={patternUrls.pageUrl("ui/pattern-room/orders")}>订单打板/杂事看板</a>}
    {canCreatePatternRoomOrders(user) && <a className="dx-button dx-button--secondary" href={patternUrls.pageUrl("ui/pattern-room/create")}>创建订单</a>}
    {canAccessPatternRoomPrices(user) && <a className="dx-button dx-button--secondary" href={patternUrls.pageUrl("ui/pattern-room/prices")}>价格管控</a>}
    <DigitalProductionEntry />
  </div></Surface>}</div>;
}
