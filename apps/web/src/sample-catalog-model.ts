import type { SampleView } from '@dx-rework/contracts';
import { fixedBusinessMoney } from './fixed-business-currency.js';

export function sampleDisplayMoney(value: string) {
  return fixedBusinessMoney(value);
}

export function sampleBatchSelection(items: SampleView[], selected: string[], user: { id: string; isRoot: boolean } | null) {
  if (!user) return [];
  return items.filter(item => selected.includes(item.sampleId) && item.status === 'borrowed' && (user.isRoot || item.holderUserId === user.id));
}
