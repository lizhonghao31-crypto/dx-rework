import { BUSINESS_TODO_CATEGORY_LABELS } from '@dx-rework/contracts/business-display';
import { todoCategoryTitles, todoRouteTaskLabels, todoTaskHeadingOverrides } from '@dx-rework/contracts';

// Search the existing card captions and notification titles for the same categories.
// This dictionary affects matching only; it never grants roles or capabilities.
export const todoSearchLabels: Readonly<Record<string, string>> = {
  ...Object.fromEntries(Object.entries(BUSINESS_TODO_CATEGORY_LABELS).map(([category, caption]) => [
    category, [...new Set([caption, todoCategoryTitles[category]].filter(Boolean))].join(' '),
  ])),
  ...Object.fromEntries(Object.entries(todoRouteTaskLabels).map(([route, title]) => [`route:${route}`, title])),
  ...Object.fromEntries(Object.entries(todoTaskHeadingOverrides).map(([category, title]) => [`heading:${category}`, title])),
  rework: '订单返工',
  sourcing: '外发定价选厂 外发定价&选厂',
  production: '实时生产',
  samples: '样衣管理',
  pattern_room: '订单打板',
  suppliers: '供应商中心',
  digital_production: '数字生产',
};
