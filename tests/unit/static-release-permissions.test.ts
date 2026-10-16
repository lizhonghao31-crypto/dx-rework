import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('public static release permissions and gates', () => {
  it('exercises synthetic filesystem permissions, private boundaries and HTTP content failures', () => {
    const result = spawnSync('python3', ['tests/fixtures/static-release-test.py'], { encoding: 'utf8' });
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });
  it('checks candidate and recovery trees before maintenance changes, including resume', () => {
    const source = readFileSync('scripts/deploy/update-main-maintenance.sh', 'utf8');
    expect(source.indexOf('static_readable "$candidate_sha"')).toBeLessThan(source.indexOf('phase maintenance-prepared'));
    expect(source.indexOf('static_readable "$active_sha"')).toBeLessThan(source.indexOf('phase maintenance-prepared'));
    expect(source.indexOf('if ! static_readable "$candidate_sha"; then')).toBeLessThan(source.indexOf('link_config "$state/maintenance.conf"'));
    expect(source).toContain('maintenance retained, no old-schema rollback');
  });
  it('checks online candidate before start/switch and gates success and recovery on static HTTP', () => {
    const source = readFileSync('scripts/deploy/update-main-online.sh', 'utf8');
    expect(source.indexOf('static_readable "$candidate_sha"')).toBeLessThan(source.indexOf('worker start-online-slot.sh start "$candidate_sha"'));
    for (const name of ['update-main-online.sh', 'update-main-maintenance.sh']) {
      const script = readFileSync(`scripts/deploy/${name}`, 'utf8');
      const verify = script.slice(script.indexOf('public_verify()'), script.indexOf('\n}', script.indexOf('public_verify()')));
      expect(verify).toContain('static-release.py" http');
      expect(verify).toContain('static_readable "$1"');
      expect(script).toContain('public_verify "$active_sha" || return');
    }
  });
});

describe('static preflight failure routing', () => {
  it('does not block rollback on an unreadable rejected candidate', () => {
    const script = readFileSync('scripts/deploy/update-main-online.sh', 'utf8');
    const start = script.indexOf('# Do not gate an interrupted rollback');
    const block = script.slice(start, script.indexOf('\nesac', start) + 5);
    for (const phase of ['prepared', 'switching', 'switched', 'rolling-back']) {
      const result = spawnSync('bash', ['-c', `set -e; cat(){ echo "$1"; }; static_readable(){ echo CHECK; return 1; }; state=fixture; candidate_sha=candidate; active_sha=active; ${block.replace('$(cat "$state/phase")', phase)}; echo CONTINUE`], { encoding: 'utf8' });
      expect(result.status).toBe(['prepared', 'switching'].includes(phase) ? 1 : 0);
      expect(result.stdout.includes('CONTINUE')).toBe(['switched', 'rolling-back'].includes(phase));
    }
  });
  it('restores maintenance routing when activation resume finds unreadable static files', () => {
    const script = readFileSync('scripts/deploy/update-main-maintenance.sh', 'utf8');
    const start = script.indexOf('if ! static_readable "$candidate_sha"; then');
    const block = script.slice(start, script.indexOf('\nif [[ "$(cat "$state/phase")" == maintenance-prepared', start));
    for (const phase of ['maintenance-prepared', 'maintenance-activating']) {
      const result = spawnSync('bash', ['-c', `set -e; static_readable(){ return 1; }; link_config(){ echo ROUTE_MAINTENANCE; }; nginx(){ return 0; }; die(){ exit 64; }; state=fixture; candidate_sha=candidate; ${block.replace('$(cat "$state/phase")', phase)}; echo CONTINUE`], { encoding: 'utf8' });
      expect(result.status).toBe(64);
      expect(result.stdout.includes('ROUTE_MAINTENANCE')).toBe(phase === 'maintenance-activating');
      expect(result.stdout).not.toContain('CONTINUE');
    }
  });
});
