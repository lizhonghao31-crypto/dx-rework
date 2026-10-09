import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync} from 'node:fs';
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
function dependencyFingerprint(root: string): string {
  const hash = createHash('sha256');
  function visit(directory: string) {
    for (const entry of readdirSync(directory).sort()) {
      const file = join(directory, entry); const stat = lstatSync(file);
      hash.update(`${file.slice(root.length)}\0${stat.mode}\0`);
      if (stat.isSymbolicLink()) hash.update(`link\0${readlinkSync(file)}\0`);
      else if (stat.isDirectory()) { hash.update('directory\0'); visit(file); }
      else { hash.update('file\0'); hash.update(readFileSync(file)); hash.update('\0'); }
    }
  }
  visit(root); return hash.digest('hex');
}
function fixture(flatten = true, realCompiler = false) {
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
  if (realCompiler) {
    rmSync(join(source, 'vendor/typescript'), {recursive: true});
    cpSync(process.env.DX_TEST_TYPESCRIPT_ROOT ?? join(repository, 'node_modules/typescript'), join(source, 'vendor/typescript'), {recursive: true});
    write(join(source, 'packages/contracts/package.json'), JSON.stringify({name: '@dx-rework/contracts', version: '0.1.0', private: true, scripts: {build: 'tsc -p tsconfig.json'}}));
    write(join(source, 'packages/contracts/tsconfig.json'), JSON.stringify({compilerOptions: {target: 'ES2022', outDir: 'dist', strict: true}, include: ['src/*.ts']}));
    write(join(source, 'packages/contracts/src/index.ts'), 'export const candidateValue: number = 42;\n');
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

  it('compiles real TypeScript through two successive reuse and unchanged package-release rounds', () => {
    const f = fixture(true, true);
    const second = mkdtempSync(join(tmpdir(), 'dx-main-update.'));
    try {
      const activeBin = join(f.current, 'node_modules/.bin/tsc');
      const activeBefore = readFileSync(activeBin);
      const activeDependenciesBefore = dependencyFingerprint(join(f.current, 'node_modules'));
      expect(run('bash', [prepare, f.candidate, f.current], repository, f.env).status).toBe(0);
      const firstBuild = run('npm', ['run', 'build', '--workspace', '@dx-rework/contracts'], f.candidate, f.env);
      expect(firstBuild.status, firstBuild.stderr).toBe(0);
      expect(readFileSync(join(f.candidate, 'packages/contracts/dist/index.js'), 'utf8')).toContain('42');
      // Exercise the original complete packaging script, including cp -aL.
      for (const directory of ['apps/api/dist', 'apps/api/migrations', 'apps/web/dist', 'packages/config/dist', 'packages/domain/dist']) mkdirSync(join(f.candidate, directory), {recursive: true});
      write(join(f.candidate, 'apps/web/dist/index.html'), '<html>fixture</html>');
      write(join(f.candidate, 'apps/api/src/platform/migration-manifest.json'), JSON.stringify({migrations: [{version: '0001_fixture', checksum: 'fixture'}]}));
      cpSync(join(repository, 'scripts/deploy'), join(f.candidate, 'scripts/deploy'), {recursive: true});
      for (const file of ['backup-postgres.sh', 'restore-postgres.sh', 'migrate.mjs', 'migration-lib.mjs', 'migration-history-policy.mjs', 'migration-branches.json', 'migration-main-extensions.json']) write(join(f.candidate, 'scripts', file), '');
      for (const file of ['infra/pm2/ecosystem.config.cjs', 'infra/pm2/ecosystem.acceptance.config.cjs', 'infra/systemd/dx-rework-postgres-backup.service', 'infra/systemd/dx-rework-postgres-backup.timer']) write(join(f.candidate, file), '');
      const buildRoot = join(f.source, 'releases'); mkdirSync(buildRoot);
      const bundle = join(buildRoot, 'a'.repeat(40));
      const packaged = run('bash', [join(repository, 'scripts/deploy/package-release.sh'), 'a'.repeat(40), '2026-10-09T00:00:00Z', bundle], f.candidate, {...f.env, DX_REWORK_BUILD_ROOT: buildRoot});
      expect(packaged.status, packaged.stderr).toBe(0);
      const packagedBin = join(bundle, 'api/node_modules/.bin/tsc');
      const packagedBefore = readFileSync(packagedBin);
      const packagedDependenciesBefore = dependencyFingerprint(join(bundle, 'api/node_modules'));
      expect(lstatSync(packagedBin).isSymbolicLink()).toBe(false);
      expect(run(packagedBin, ['--version'], join(bundle, 'api')).status).not.toBe(0);
      for (const entry of ['package.json', 'package-lock.json', '.npmrc', 'packages', 'apps', 'vendor']) cpSync(join(f.candidate, entry), join(second, entry), {recursive: true});
      expect(run('bash', [prepare, second, join(bundle, 'api')], repository, f.env).status).toBe(0);
      const secondBuild = run('npm', ['run', 'build', '--workspace', '@dx-rework/contracts'], second, f.env);
      expect(secondBuild.status, secondBuild.stderr).toBe(0);
      expect(readFileSync(join(second, 'packages/contracts/dist/index.js'), 'utf8')).toContain('42');
      expect(readFileSync(activeBin).equals(activeBefore)).toBe(true);
      expect(readFileSync(packagedBin).equals(packagedBefore)).toBe(true);
      expect(dependencyFingerprint(join(f.current, 'node_modules'))).toBe(activeDependenciesBefore);
      expect(dependencyFingerprint(join(bundle, 'api/node_modules'))).toBe(packagedDependenciesBefore);
      expect(lstatSync(activeBin).isSymbolicLink()).toBe(false);
      expect(lstatSync(packagedBin).isSymbolicLink()).toBe(false);
      expect(readFileSync(f.commandLog, 'utf8')).not.toContain('ci --');
    } finally { rmSync(second, {recursive: true, force: true}); f.cleanup(); }
  }, 30000);
});
