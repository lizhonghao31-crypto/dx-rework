import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
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
});
