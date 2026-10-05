import { readdirSync, readFileSync } from 'node:fs';
const workers = [];
for (const name of readdirSync('/proc')) {
  if (!/^\d+$/.test(name)) continue;
  try {
    const command = readFileSync(`/proc/${name}/cmdline`, 'utf8');
    if (!command.startsWith('nginx: worker process')) continue;
    const fields = readFileSync(`/proc/${name}/stat`, 'utf8').split(')').at(-1).trim().split(/\s+/);
    workers.push({ pid: Number(name), start: fields[19] });
  } catch { /* A worker may exit while /proc is read. */ }
}
process.stdout.write(JSON.stringify(workers));
