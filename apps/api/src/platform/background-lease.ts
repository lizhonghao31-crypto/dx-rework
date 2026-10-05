import { closeSync, constants, fstatSync, openSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

/** Single-host lease held by the API's open file description, not a helper PID. */
export class BackgroundLease {
  private descriptor: number | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private started = false;

  constructor(private readonly path: string, private readonly start: () => void, private readonly failed: (error: unknown) => void) {}

  acquire(): void {
    if (!this.path.startsWith('/') || this.path.includes('..')) throw new Error('Invalid background lease path');
    this.descriptor = openSync(this.path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    const stat = fstatSync(this.descriptor);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0) {
      this.close();
      throw new Error('Unsafe background lease file');
    }
    const attempt = (): void => {
      if (this.descriptor === undefined || this.started) return;
      // flock(2) locks the shared open file description. The parent retains it
      // after this short-lived helper exits, until close() or process death.
      const result = spawnSync('/usr/bin/flock', ['-n', '-E', '75', '3'], {
        stdio: ['ignore', 'ignore', 'pipe', this.descriptor],
      });
      if (result.status === 75) return;
      if (result.error || result.status !== 0) throw new Error('Background lease acquisition failed');
      this.started = true;
      if (this.timer) clearInterval(this.timer);
      this.start();
    };
    attempt();
    if (!this.started) this.timer = setInterval(() => {
      try { attempt(); } catch (error) {
        if (this.timer) clearInterval(this.timer);
        this.failed(error);
      }
    }, 1_000);
  }

  /** Call only after all background tasks have stopped and drained. */
  close(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.descriptor !== undefined) closeSync(this.descriptor);
    this.descriptor = undefined;
  }
}
