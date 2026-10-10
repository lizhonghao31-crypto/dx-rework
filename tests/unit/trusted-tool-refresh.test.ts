import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { describe, it, expect } from 'vitest';

describe('installed tool authorizes data refresh only', () => {
  it('accepts a real complete data refresh, rejects policy drift, missing blobs and historical edits', () => {
    const root = mkdtempSync(join(tmpdir(), 'tool-refresh-'));
    try {
      const old = join(root, 'old'); const candidate = join(root, 'new');
      for (const directory of [old, candidate]) {
        for (const path of ['scripts', 'infra', 'apps/api/migrations', 'apps/api/src/platform']) mkdirSync(join(directory, path), { recursive: true });
        writeFileSync(join(directory, 'scripts/policy.sh'), 'exit 0\n');
        writeFileSync(join(directory, 'package.json'), '{}');
        writeFileSync(join(directory, 'package-lock.json'), '{}');
        writeFileSync(join(directory, 'scripts/migration-main-extensions.json'), '[]');
        writeFileSync(join(directory, 'apps/api/migrations/0001_test.sql'), 'SELECT 1;');
        const checksum = createHash('sha256').update('SELECT 1;').digest('hex');
        writeFileSync(join(directory, 'apps/api/src/platform/migration-manifest.json'), JSON.stringify({ migrations: [{ version: '0001_test', checksum }] }));
      }
      const run = () => spawnSync('python3', ['scripts/deploy/verify-tool-refresh.py', old, candidate], { encoding: 'utf8' });
      expect(run().status).toBe(0);
      writeFileSync(join(candidate, 'scripts/policy.sh'), 'exit 1\n');
      expect(run().stderr).toContain('TOOL_CODE_UPGRADE_REQUIRED');
      writeFileSync(join(candidate, 'scripts/policy.sh'), 'exit 0\n');
      writeFileSync(join(candidate, 'apps/api/migrations/0001_test.sql'), 'SELECT 2;');
      expect(run().stderr).toContain('SQL and manifest disagree');
      rmSync(join(candidate, 'apps/api/migrations/0001_test.sql'));
      expect(run().status).not.toBe(0);
      writeFileSync(join(candidate, 'apps/api/src/platform/migration-manifest.json'), '{"migrations":[]}');
      expect(run().stderr).toContain('Frozen migration fingerprint');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('keeps the approved tool script frozen while preserving the relocated browser coverage', () => {
    const frozen = readFileSync('scripts/acceptance/digital-analysis-layout-regression.mjs', 'utf8');
    expect(createHash('sha256').update(frozen).digest('hex')).toBe('07e1948c19d65ba705b35a2dccba6a6f26f1a20c7d72ef00915cf91a28c46380');
    const relocated = readFileSync('tests/acceptance/digital-analysis-layout-regression.mjs', 'utf8');
    expect(relocated).toContain('await assertNodeAlignment(page)');
    expect(relocated).toContain('[320,844]');
    expect(relocated).toContain('TEST开发核配委派（客户新增印绣与洗水工艺确认的超长节点名称）');
    expect(relocated).toContain("query.get('metric'),'overdue'");
    expect(relocated).toContain("saved.taskIds,[id]");
    expect(relocated).toContain("导出当前授权范围（含规则版本）");
  });

  it('allows repeated app and isolated test refreshes without relaxing protected policy or dependencies', () => {
    const root = mkdtempSync(join(tmpdir(), 'tool-refresh-analysis-'));
    try {
      const old = join(root, 'old'); const candidate = join(root, 'new');
      for (const directory of [old, candidate]) {
        for (const path of ['scripts/acceptance', 'infra', 'apps/api/migrations', 'apps/api/src/platform', 'tests/acceptance']) mkdirSync(join(directory, path), { recursive: true });
        writeFileSync(join(directory, 'scripts/acceptance/digital-analysis-layout-regression.mjs'), readFileSync('scripts/acceptance/digital-analysis-layout-regression.mjs'));
        writeFileSync(join(directory, 'package.json'), '{}');
        writeFileSync(join(directory, 'package-lock.json'), '{}');
        writeFileSync(join(directory, 'scripts/migration-main-extensions.json'), '[]');
        writeFileSync(join(directory, 'apps/api/migrations/0001_test.sql'), 'SELECT 1;');
        const checksum = createHash('sha256').update('SELECT 1;').digest('hex');
        writeFileSync(join(directory, 'apps/api/src/platform/migration-manifest.json'), JSON.stringify({ migrations: [{ version: '0001_test', checksum }] }));
      }
      const run = () => spawnSync('python3', ['scripts/deploy/verify-tool-refresh.py', old, candidate], { encoding: 'utf8' });
      writeFileSync(join(candidate, 'tests/acceptance/digital-analysis-layout-regression.mjs'), readFileSync('tests/acceptance/digital-analysis-layout-regression.mjs'));
      expect(run().status).toBe(0);
      writeFileSync(join(candidate, 'tests/acceptance/digital-analysis-layout-regression.mjs'), 'console.log("next isolated test revision");\n');
      writeFileSync(join(candidate, 'apps/api/next-app-revision.ts'), 'export const revision = 2;\n');
      expect(run().status).toBe(0);
      writeFileSync(join(candidate, 'scripts/acceptance/digital-analysis-layout-regression.mjs'), 'console.log("protected drift");\n');
      expect(run().stderr).toContain('TOOL_CODE_UPGRADE_REQUIRED: executable policy changed');
      writeFileSync(join(candidate, 'scripts/acceptance/digital-analysis-layout-regression.mjs'), readFileSync('scripts/acceptance/digital-analysis-layout-regression.mjs'));
      writeFileSync(join(candidate, 'infra/unknown-policy.sh'), 'exit 0\n');
      expect(run().stderr).toContain('TOOL_CODE_UPGRADE_REQUIRED: executable policy changed');
      rmSync(join(candidate, 'infra/unknown-policy.sh'));
      for (const path of ['package.json', 'package-lock.json']) {
        writeFileSync(join(candidate, path), '{"changed":true}');
        expect(run().stderr).toContain('TOOL_CODE_UPGRADE_REQUIRED: dependency contract changed');
        writeFileSync(join(candidate, path), '{}');
      }
      expect(run().status).toBe(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
