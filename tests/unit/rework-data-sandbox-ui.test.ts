import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';

describe('rework data sandbox pilot', () => {
  it('keeps the original rework workspace and adds a separate management sandbox route', async () => {
    const [app, shell, page] = await Promise.all([
      readFile(new URL('../../apps/web/src/App.tsx', import.meta.url), 'utf8'),
      readFile(new URL('../../apps/web/src/components.tsx', import.meta.url), 'utf8'),
      readFile(new URL('../../apps/web/src/rework-data-sandbox-page.tsx', import.meta.url), 'utf8'),
    ]);
    expect(app).toContain('/ui/rework-data-sandbox');
    expect(app).toContain('<ReworkQueryPage />');
    expect(shell).toContain('name: "数据沙盘"');
    expect(shell).toContain('href: "/ui/rework-data-sandbox"');
    expect(page).toContain('分析期间 A');
    expect(page).toContain('对比期间 B');
    expect(page).toContain('平均流转时长');
    expect(page).toContain('流转最久环节');
    expect(page).toContain('包含排队、等待、夜间和休息时间');
    expect(page).toContain('management/workflow-analysis');
  });
});
