import {spawnSync} from 'node:child_process';
import {chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';

const repository = process.cwd();
const helper = join(repository, 'scripts/deploy/dependency-bins.mjs');
const prepare = join(repository, 'scripts/deploy/prepare-build-dependencies.sh');
const npm = process.env.DX_TEST_NPM_CLI;
const workspaces = ['packages/contracts', 'packages/config', 'packages/domain', 'packages/ui', 'apps/api', 'apps/web'];
function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = {}) {
  return spawnSync(command, args, {cwd, encoding: 'utf8', env: {...process.env, ...env}});
}
function write(file: string, content: string) { mkdirSync(join(file, '..'), {recursive: true}); writeFileSync(file, content); }
function fixture(flatten = true) {
  const source = mkdtempSync(join(tmpdir(), 'dx-dependency-source-'));
  const current = mkdtempSync(join(tmpdir(), 'dx-dependency-current-'));
  const candidate = mkdtempSync(join(tmpdir(), 'dx-main-update.'));
  const commandLog = join(source, 'npm-commands.log');
  const bin = join(source, 'tools'); mkdirSync(bin);
  // Resolve npm before adding the logging wrapper to PATH.
  const npmCommand = npm ? `${process.execPath} ${npm}` : run('bash', ['-c', 'command -v npm'], repository).stdout.trim();
  write(join(bin, 'npm'), `#!/usr/bin/env bash\nset -euo pipefail\nprintf '%s\\n' "$*" >> '${commandLog}'\n${npmCommand} "$@"\nif [[ "\${1:-}" == ci && "\${DX_BREAK_INSTALLED_CLI:-}" == true ]]; then rm -f node_modules/typescript/lib/tsc.js; fi\n`);
  chmodSync(join(bin, 'npm'), 0o755);
  write(join(source, 'package.json'), JSON.stringify({name: 'bin-fixture', version: '1.0.0', private: true, workspaces, devDependencies: {typescript: 'file:vendor/typescript', vite: 'file:vendor/vite'}}));
  write(join(source, '.npmrc'), 'install-links=true\n');
  for (const workspace of workspaces) write(join(source, workspace, 'package.json'), JSON.stringify({name: `@dx-rework/${workspace.split('/')[1]}`, version: '0.1.0', private: true}));
  for (const [name, executable, output] of [['typescript', 'tsc', 'Version 5.9.3'], ['vite', 'vite', 'vite/8.2.0']]) {
    write(join(source, 'vendor', name, 'package.json'), JSON.stringify({name, version: '1.0.0', bin: {[executable]: `bin/${executable}`}, scripts: {install: `node -e "require('fs').writeFileSync('${source}/lifecycle-ran','yes')"`}}));
    write(join(source, 'vendor', name, 'bin', executable), `#!/usr/bin/env node\nrequire('../lib/${executable}.js')\n`);
    chmodSync(join(source, 'vendor', name, 'bin', executable), 0o755);
    write(join(source, 'vendor', name, 'lib', `${executable}.js`), `console.log('${output}')\n`);
  }
  const cache = {npm_config_cache: join(source, 'npm-cache')};
  const install = npm ? run(process.execPath, [npm, 'install', '--ignore-scripts', '--offline', '--no-audit', '--no-fund'], source, cache) : run('npm', ['install', '--ignore-scripts', '--offline', '--no-audit', '--no-fund'], source, cache);
  expect(install.status, install.stderr).toBe(0);
  for (const entry of ['package.json', 'package-lock.json', '.npmrc', 'packages', 'apps', 'vendor']) cpSync(join(source, entry), join(candidate, entry), {recursive: true});
  cpSync(join(source, 'package-lock.json'), join(current, 'package-lock.json'));
  const copy = run('cp', [flatten ? '-aL' : '-a', join(source, 'node_modules'), current], repository);
  expect(copy.status, copy.stderr).toBe(0);
  const env = {...cache, PATH: `${bin}:${process.env.PATH ?? ''}`};
  const cleanup = () => { for (const directory of [source, current, candidate]) rmSync(directory, {recursive: true, force: true}); };
  return {source, current, candidate, commandLog, env, cleanup};
}

describe('deployment candidate dependency bins', () => {
  it('repairs flattened candidate bins without mutating the active dependency tree or running lifecycle scripts', () => {
    const f = fixture();
    try {
      const activeBin = join(f.current, 'node_modules/.bin/tsc');
      const before = readFileSync(activeBin);
      expect(lstatSync(activeBin).isSymbolicLink()).toBe(false);
      expect(run(activeBin, ['--version'], f.current).status).not.toBe(0);
      const result = run('bash', [prepare, f.candidate, f.current], repository, f.env);
      expect(result.status, result.stderr).toBe(0);
      expect(readlinkSync(join(f.candidate, 'node_modules/.bin/tsc'))).toBe('../typescript/bin/tsc');
      expect(run('node', [helper, 'verify-build', f.candidate], repository).status).toBe(0);
      expect(readFileSync(activeBin).equals(before)).toBe(true);
      expect(lstatSync(activeBin).isSymbolicLink()).toBe(false);
      expect(existsSync(join(f.source, 'lifecycle-ran'))).toBe(false);
      expect(readFileSync(f.commandLog, 'utf8')).not.toContain('ci --');
    } finally { f.cleanup(); }
  });

  it('keeps correct bin links and rebinds only candidate workspaces', () => {
    const f = fixture(false);
    try {
      const result = run('bash', [prepare, f.candidate, f.current], repository, f.env);
      expect(result.status, result.stderr).toBe(0);
      expect(readlinkSync(join(f.candidate, 'node_modules/.bin/tsc'))).toBe('../typescript/bin/tsc');
      expect(readlinkSync(join(f.candidate, 'node_modules/@dx-rework/contracts'))).toBe('../../packages/contracts');
      expect(readFileSync(f.commandLog, 'utf8')).not.toContain('ci --');
    } finally { f.cleanup(); }
  });

  it('falls back to npm ci when package metadata passes but the compiler payload is missing', () => {
    const f = fixture();
    try {
      rmSync(join(f.current, 'node_modules/typescript/lib/tsc.js'));
      const result = run('bash', [prepare, f.candidate, f.current], repository, f.env);
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(f.commandLog, 'utf8')).toContain('ci --prefer-offline');
      expect(run('node', [helper, 'verify-build', f.candidate], repository).status).toBe(0);
      expect(existsSync(join(f.current, 'node_modules/typescript/lib/tsc.js'))).toBe(false);
    } finally { f.cleanup(); }
  });

  it('fails closed when the fresh install still has an unusable CLI', () => {
    const f = fixture();
    try {
      rmSync(join(f.current, 'node_modules/typescript/lib/tsc.js'));
      const result = run('bash', [prepare, f.candidate, f.current], repository, {...f.env, DX_BREAK_INSTALLED_CLI: 'true'});
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('candidate build dependencies are unhealthy');
    } finally { f.cleanup(); }
  });

});
