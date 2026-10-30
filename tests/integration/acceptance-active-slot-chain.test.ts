import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const script = 'tests/integration/acceptance-active-slot-chain.test.py';
const allCases = [...readFileSync(script, 'utf8').matchAll(/^ {4}def (test_\w+)\(/gm)].map(match => match[1]);
const activationCases = [
  'test_start_failure_keeps_stopped_registration_and_same_sha_retry_skips_migration',
  'test_first_stopped_save_failure_blocks_migration',
  'test_backup_stopped_save_failure_blocks_migration',
  'test_hard_kill_after_delete_resumes_through_original_update_entry',
  'test_hard_kill_after_start_revalidates_before_online_save',
  'test_missing_registration_without_witness_is_rejected',
  'test_missing_registration_with_wrong_sha_is_rejected',
  'test_missing_registration_with_wrong_dump_is_rejected',
];
const originalCases = allCases.filter(name => !activationCases.includes(name));
function runCases(cases: string[], count: number) {
  const result = spawnSync('python3', [script, ...cases.map(name => `ActiveSlotChainTests.${name}`)], {
    encoding: 'utf8', timeout: 180000,
  });
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  expect(result.stderr).toContain(`Ran ${count} tests`);
  expect(result.stderr).toContain('OK');
}

describe('offline Acceptance active-slot script chain', () => {
  it('runs real controllers, worker, verifier, explicit tool installation and rollback', () => {
    expect(allCases).toHaveLength(22);
    expect(new Set(allCases).size).toBe(22);
    expect(originalCases).toHaveLength(14);
    expect(activationCases).toHaveLength(8);
    expect(activationCases.every(name => allCases.includes(name))).toBe(true);
    runCases(originalCases, 14);
  }, 190000);
  it('runs every added PM2 interruption and persistence case within the same bounded timeout', () => {
    runCases(activationCases, 8);
  }, 190000);
});
