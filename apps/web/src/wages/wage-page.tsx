import { WagePeriodDetailPage } from "./wage-period-detail.js";
import { WagePeriodList } from "./wage-period-list.js";

const WAGE_PERIOD_PATH = /^\/ui\/wages\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

export function WagePage({ path }: { path: string }) {
  const match = path.match(WAGE_PERIOD_PATH);
  return match ? <WagePeriodDetailPage periodId={match[1]!} /> : <WagePeriodList />;
}
