import { Button, Surface } from "@dx-rework/ui";
import { Header } from "./components.js";
import { createWebUrls } from "../url-contract.js";

export function PatternRoomPage({ creating = false }: { creating?: boolean }) {
  const { pageUrl } = createWebUrls(import.meta.env.BASE_URL);
  return <>
    <Header title={creating ? "创建订单" : "订单打板"} badge="订单打板" badgePlacement="subtitle" />
    {creating ? <Surface><h2>订单创建尚未开放</h2><p>开放后可在这里提交打板与杂事请求。</p><Button disabled>创建订单</Button></Surface>
      : <Surface><a href={pageUrl("ui/pattern-room/create")}><Button>创建订单</Button></a>{" "}<a href={pageUrl("ui/pattern-room/prices")}><Button>板房价格管控</Button></a></Surface>}
  </>;
}
