import type { SampleView } from '@dx-rework/contracts';

export function sampleDisplayMoney(value: string) {
  const [whole = '', fraction = ''] = value.split('.');
  const decimals = fraction.replace(/0+$/, '');
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (decimals ? `.${decimals}` : '');
}

export function sampleBatchSelection(items: SampleView[], selected: string[], user: { id: string; isRoot: boolean } | null) {
  if (!user) return [];
  return items.filter(item => selected.includes(item.sampleId) && item.status === 'borrowed' && (user.isRoot || item.holderUserId === user.id));
}
