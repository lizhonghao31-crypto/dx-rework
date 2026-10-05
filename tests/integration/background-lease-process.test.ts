import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { describe, it, expect } from 'vitest';

describe('real process background responsibility transfer', () => {
  it('holds the parent-owned lock throughout shutdown drain and releases it after process death', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dx-lease-'));
    const processes: ChildProcessWithoutNullStreams[] = [];
    const launch = () => {
      const child = spawn(process.execPath, ['--import', 'tsx', 'tests/fixtures/background-lease-process.mjs', join(directory, 'background.lock')]);
      processes.push(child);
      let output = ''; child.stdout.on('data', data => { output += data; });
      let errors = ''; child.stderr.on('data', data => { errors += data; });
      return { child, output: () => output, errors: () => errors };
    };
    const wait = async (condition: () => boolean) => {
      const deadline = Date.now() + 5_000;
      while (!condition() && Date.now() < deadline) await setTimeout(25);
      expect(condition()).toBe(true);
    };
    try {
      const first = launch(); await wait(() => first.output().includes('ACQUIRED'));
      const second = launch(); await setTimeout(400); expect(second.output()).not.toContain('ACQUIRED');
      first.child.kill('SIGTERM'); await wait(() => first.output().includes('DRAINING'));
      await setTimeout(200); expect(second.output()).not.toContain('ACQUIRED');
      await wait(() => second.output().includes('ACQUIRED'));
      expect(first.child.exitCode).toBe(0);
      const third = launch(); await setTimeout(300); expect(third.output()).not.toContain('ACQUIRED');
      second.child.kill('SIGKILL'); await wait(() => third.output().includes('ACQUIRED'));
      expect(first.errors() + second.errors() + third.errors()).toBe('');
    } finally {
      for (const child of processes) { child.kill('SIGKILL'); }
      await setTimeout(50); rmSync(directory, { recursive: true, force: true });
    }
  }, 15_000);
});
