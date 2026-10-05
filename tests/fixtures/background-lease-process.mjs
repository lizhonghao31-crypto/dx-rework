import { BackgroundLease } from '../../apps/api/src/platform/background-lease.ts';
import { setTimeout } from 'node:timers/promises';
const lease = new BackgroundLease(process.argv[2], () => process.stdout.write('ACQUIRED\n'), error => { throw error; });
lease.acquire();
process.on('SIGTERM', async () => {
  process.stdout.write('DRAINING\n');
  await setTimeout(500);
  lease.close();
  process.exit(0);
});
setInterval(() => {}, 1_000);
