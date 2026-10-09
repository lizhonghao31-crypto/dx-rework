import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('offline Acceptance active-slot script chain', () => {
  it('runs real controllers, worker, verifier, explicit tool installation and rollback', () => {
    const result = spawnSync('python3', ['tests/integration/acceptance-active-slot-chain.test.py'], {
      encoding: 'utf8', timeout: 90000,
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stderr).toContain('Ran 6 tests');
    expect(result.stderr).toContain('OK');
  }, 100000);
});
