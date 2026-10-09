import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const inside = (root, target) => target.startsWith(`${root}${path.sep}`);
const [action, first] = process.argv.slice(2);
if (action === 'verify-build') {
  const root = fs.realpathSync(first);
  for (const [workspace, name, version] of [['packages/contracts', 'tsc', /^Version \d+\./], ['apps/web', 'vite', /^vite\/\d+\./]]) {
    const cwd = path.join(root, workspace);
    let directory = cwd, bin;
    while (directory === root || inside(root, directory)) {
      const file = path.join(directory, 'node_modules', '.bin', name);
      if (fs.existsSync(file)) { bin = file; break; }
      directory = path.dirname(directory);
    }
    if (!bin || !fs.lstatSync(bin).isSymbolicLink() || !inside(root, fs.realpathSync(bin))) throw Error(`build CLI link invalid: ${name}`);
    const result = spawnSync(bin, ['--version'], {cwd, encoding: 'utf8', timeout: 30000});
    if (result.error || result.status !== 0 || !version.test(result.stdout.trim())) throw Error(`build CLI failed: ${name}\n${result.stderr || result.error || result.stdout}`);
  }
} else {
  throw Error('usage: dependency-bins.mjs verify-build CANDIDATE');
}
