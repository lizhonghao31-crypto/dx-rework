import { Button, Surface } from "@dx-rework/ui";
import { Header } from "./components.js";
import { createWebUrls } from "../url-contract.js";

export function FinancePage() {
  const { base } = createWebUrls(import.meta.env.BASE_URL);
  return <>
    <Header title="财务中心" badge="财务中心" badgePlacement="subtitle" />
    <Surface>
      <a href={`${base}ui/wages`}><Button>工资管理</Button></a>
    </Surface>
  </>;
}
