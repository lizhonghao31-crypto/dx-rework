import { readFileSync, readdirSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';
const [path] = process.argv.slice(2);
const workers = JSON.parse(readFileSync(path, 'utf8'));
if (!Array.isArray(workers) || !workers.every(w => Number.isSafeInteger(w.pid) && /^\d+$/.test(w.start))) throw Error('Invalid drain receipt');
const live = ({ pid, start }) => {
  try { return readFileSync(`/proc/${pid}/stat`, 'utf8').split(')').at(-1).trim().split(/\s+/)[19] === start; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
};
const deadline = Date.now() + 300_000;
const shuttingDown = () => readdirSync('/proc').some(pid => {
  if (!/^\d+$/.test(pid)) return false;
  try { return readFileSync(`/proc/${pid}/cmdline`, 'utf8').startsWith('nginx: worker process is shutting down'); }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') return false; throw error; }
});
while (workers.some(live) || shuttingDown()) {
  if (Date.now() >= deadline) throw Error('DRAIN_PENDING: old API retained; repeat fixed update command to resume');
  await setTimeout(1_000);
}
process.stdout.write('NGINX_GENERATION_DRAINED\n');
