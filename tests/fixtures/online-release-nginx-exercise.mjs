// Run ONLY in the disposable PG13/Node22/nginx container documented in the runbook.
// Uses the real compiled API, its existing isolated Acceptance identity provider,
// real QC HTTP routes/idempotency, and real nginx/PM2. Generation labels are synthetic.
import { createHmac, randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, writeFileSync, existsSync, symlinkSync, rmSync, unlinkSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { request } from 'node:https';
import { setTimeout } from 'node:timers/promises';
import pg from 'pg';
import { applyMigrations } from '../../scripts/migration-lib.mjs';
import { assertTestDatabaseTarget } from '../../scripts/test-database-safety.mjs';
import { ownedPostgresSchema } from '../helpers/owned-postgres-schema.ts';

if (process.getuid() !== 0 || !existsSync('/.dockerenv') || process.env.DX_RELEASE_EXERCISE !== '1') throw Error('Disposable container only');
await assertTestDatabaseTarget();
const source = process.cwd();
const schema = ownedPostgresSchema('release_nginx');
const admin = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL }); await admin.connect();
const scoped = new URL(process.env.TEST_DATABASE_URL); scoped.searchParams.set('options', `-c search_path=${schema}`);
// libpq URI options require percent-encoded spaces rather than form '+' encoding.
scoped.search = scoped.search.replaceAll('+', '%20');
const database = new pg.Pool({ connectionString: scoped.toString() });
const blocker = new pg.Client({ connectionString: scoped.toString() });
const historical = process.env.DX_RELEASE_HISTORICAL === '1';
const historicalSource = '/workspace/dx-historical-main';
const oldSha = historical ? 'b7d400e623da6381302bf70509ee7fe81b6ac3e8' : '1'.repeat(40), newSha = '2'.repeat(40);
const root = '/opt/dx-rework'; const state = '/opt/dx-rework-release-state';
const tool = `/opt/dx-rework-release-tools/${newSha}`;
const node = process.execPath;
const run = (command, args, options = {}) => execFileSync(command, args, { encoding: 'utf8', ...options });
const user = (script, ...args) => run('runuser', ['-u', 'dxrework', '--', 'env', '-i', 'HOME=/home/dxrework', 'USER=dxrework', `PATH=${process.env.PATH}`, 'bash', `${tool}/scripts/deploy/${script}`, ...args], { cwd: '/home/dxrework' });
const wait = async (condition, description) => {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) { if (await condition()) return; await setTimeout(50); }
  throw Error(`Timed out: ${description}`);
};
let certificate;
const http = (path, method = 'GET', body, key) => new Promise((resolve, reject) => {
  const stream = request({ hostname: '127.0.0.1', port: 443, servername: 'dxerp.org.cn', ca: certificate, agent: false,
    path, method, headers: { host: 'dxerp.org.cn', origin: 'https://dxerp.org.cn', cookie: 'dx_rework_session=isolated-qc-session',
      ...(body ? { 'content-type': 'application/json' } : {}), ...(key ? { 'idempotency-key': key } : {}) } }, response => {
    let text = ''; response.on('data', data => { text += data; });
    response.on('end', () => {
      try { resolve({ status: response.statusCode, headers: response.headers, value: JSON.parse(text) }); }
      catch { reject(Error(`HTTP ${response.statusCode}: ${text.slice(0, 160)}`)); }
    });
  });
  stream.setTimeout(15_000, () => stream.destroy(Error('request timeout'))); stream.on('error', reject);
  stream.end(body ? JSON.stringify(body) : undefined);
});
const orders = [];
const create = async (label) => {
  const batch = randomUUID(), key = randomUUID(), style = `RELEASE-${label}`;
  await database.query('INSERT INTO receiving_batches(receiving_batch_id,style_no,created_by,delivery_note_quantity) VALUES($1,$2,$3,1)', [batch, style, qc]);
  const input = { receivingBatchId: batch, styleNo: style };
  const response = await http('/api/rework-orders/drafts', 'POST', input, key);
  if (response.status !== 201) throw Error(`QC create failed: ${JSON.stringify(response)}`);
  orders.push({ key, input, id: response.value.reworkOrderId });
  return response;
};
const startController = (entry = 'update-main-online.sh') => {
  const child = spawn('bash', [`${tool}/scripts/deploy/${entry}`], { detached: true });
  let output = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
  const done = new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal, output })));
  return { child, done };
};
const sha = run('git', ['-c', `safe.directory=${source}`, 'rev-parse', 'HEAD']).trim();
const qc = randomUUID(), owner = randomUUID();
try {
  await admin.query(`CREATE SCHEMA ${schema}`); await blocker.connect();
  if (historical) {
    process.env.DX_REWORK_MIGRATIONS_DIR = `${historicalSource}/apps/api/migrations`;
    process.env.DX_REWORK_MIGRATION_MANIFEST = `${historicalSource}/apps/api/src/platform/migration-manifest.json`;
  }
  await applyMigrations(scoped.toString());
  delete process.env.DX_REWORK_MIGRATIONS_DIR; delete process.env.DX_REWORK_MIGRATION_MANIFEST;
  for (const [id, alias, role] of [[owner, 'root', 'owner_group'], [qc, 'qc-release', 'quality_control']]) {
    await database.query("INSERT INTO app_users(id,display_name,enabled) VALUES($1,$2,true)", [id, `ISOLATED ${alias}`]);
    await database.query("INSERT INTO identity_mappings(id,user_id,provider,corp_id,provider_user_id,union_id,active,employed,last_verified_at) VALUES($1,$2,'dingtalk','corp',$3,$4,true,true,CURRENT_TIMESTAMP)", [randomUUID(), id, `uat-${alias}`, `uat-union-${alias}`]);
    await database.query("INSERT INTO user_role_assignments(assignment_id,user_id,role_code,granted_by,grant_reason) VALUES($1,$2,$3,$2,'isolated release fixture')", [randomUUID(), id, role]);
  }
  await database.query("INSERT INTO owner_bootstrap_consumptions(singleton,user_id,provider_user_id,corp_id) VALUES(true,$1,'uat-root','corp')", [owner]);
  await database.query("INSERT INTO access_security_policy(policy_key,dingtalk_corp_id) VALUES('primary','corp')");
  await database.query('INSERT INTO auth_sessions(id,token_hash,user_id,expires_at) VALUES($1,$2,$3,CURRENT_TIMESTAMP + interval \'1 hour\')', [randomUUID(), createHmac('sha256', 's'.repeat(48)).update('isolated-qc-session').digest('hex'), qc]);
  for (const directory of ['shared', 'logs', 'locks', 'releases', 'frontend/releases', 'generations', 'candidates']) mkdirSync(`${root}/${directory}`, { recursive: true });
  writeFileSync(`${root}/locks/release.lock`, '');
  writeFileSync(`${root}/shared/.env`, `DATABASE_URL=${scoped}\nDINGTALK_CORP_ID=corp\nDINGTALK_H5_APP_KEY=isolated\nDINGTALK_H5_APP_SECRET=isolated\nDINGTALK_WEB_CLIENT_ID=isolated\nDINGTALK_WEB_CLIENT_SECRET=isolated\nDINGTALK_QR_REDIRECT_URI=https://dxerp.org.cn/auth/qr/relay\nSESSION_SECRET=${'s'.repeat(48)}\nROOT_DINGTALK_USER_ID=uat-root\nAPP_BASE_PATH=/\nTODO_RUNTIME_ENABLED=false\nTODO_DELIVERY_ENABLED=false\nTODO_TIMING_ENABLED=false\nACCEPTANCE_LAB_ENABLED=false\n`, { mode: 0o600 });
  writeFileSync(`${root}/shared/deploy.env`, `DX_REWORK_NODE_BIN=${node}\nDX_REWORK_PG_BIN_DIR=/usr/lib/postgresql/13/bin\nDX_REWORK_SERVER_NAME=dxerp.org.cn\nDX_REWORK_NGINX_CONFIG=/etc/nginx/conf.d/dx-online.conf\nDX_REWORK_NGINX_MODE=dedicated_vhost\nDX_REWORK_PROFILE=production\n`, { mode: 0o600 });
  for (const generation of [oldSha, newSha]) {
    const artifactSource = historical && generation === oldSha ? historicalSource : source;
    const api = `${root}/releases/${generation}`, web = `${root}/frontend/releases/${generation}`;
    mkdirSync(`${api}/scripts/deploy`, { recursive: true }); mkdirSync(`${api}/apps/api/dist`, { recursive: true });
    mkdirSync(`${api}/apps/api/src/platform`, { recursive: true }); mkdirSync(web, { recursive: true });
    cpSync(`${source}/scripts/deploy/start-api.sh`, `${api}/scripts/deploy/start-api.sh`);
    cpSync(`${source}/scripts/deploy/lib.sh`, `${api}/scripts/deploy/lib.sh`);
    cpSync(`${artifactSource}/apps/api/src/platform/migration-manifest.json`, `${api}/apps/api/src/platform/migration-manifest.json`);
    cpSync(`${artifactSource}/apps/api/migrations`, `${api}/apps/api/migrations`, { recursive: true });
    symlinkSync(`${source}/node_modules`, `${api}/node_modules`);
    // The actual production server runs unchanged. Its existing isolated identity
    // provider is selected only inside this disposable test payload.
    writeFileSync(`${api}/apps/api/dist/server.js`, `process.env.NODE_ENV='test';process.env.ACCEPTANCE_LAB_ENABLED='true';process.env.ACCEPTANCE_LAB_SECRET='i'.repeat(48);await import(${JSON.stringify(`${artifactSource}/apps/api/dist/server.js`)});\n`);
    writeFileSync(`${api}/package.json`, '{"type":"module"}\n');
    const lastMigration = JSON.parse(readFileSync(`${artifactSource}/apps/api/src/platform/migration-manifest.json`)).migrations.at(-1);
    writeFileSync(`${api}/release-manifest.json`, JSON.stringify({ gitSha: generation, buildTime: 'isolated', releaseProtocol: 2, schemaVersion: lastMigration.version, schemaChecksum: lastMigration.checksum }));
    mkdirSync(`${web}/assets`);
    writeFileSync(`${web}/assets/app.js`, `console.log('${generation}');`);
    writeFileSync(`${web}/index.html`, `<html>${generation}<script src="/assets/app.js"></script></html>`);
    writeFileSync(`${web}/release-manifest.json`, JSON.stringify({ gitSha: generation }));
    run('bash', ['-c', 'find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS'], { cwd: api });
    run('bash', ['-c', 'find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS'], { cwd: web });
    mkdirSync(`${root}/generations/${generation}`, { recursive: true });
    symlinkSync(api, `${root}/generations/${generation}/api`); symlinkSync(web, `${root}/generations/${generation}/frontend`);
  }
  symlinkSync(`${root}/generations/${oldSha}`, `${root}/active`);
  symlinkSync(`${root}/active/api`, `${root}/current`); symlinkSync(`${root}/active/frontend`, `${root}/frontend/current`);
  run('chown', ['-R', 'dxrework:dxrework', root]);
  mkdirSync(`${tool}/scripts/deploy`, { recursive: true }); cpSync(`${source}/scripts`, `${tool}/scripts`, { recursive: true });
  cpSync(`${source}/package.json`, `${tool}/package.json`); symlinkSync(`${root}/current/node_modules`, `${tool}/node_modules`);
  run('chmod', ['-R', 'a+rX', tool]);
  mkdirSync(state, { mode: 0o700 });
  writeFileSync(`${state}/node-binary`, node); writeFileSync(`${state}/nginx-config`, '/etc/nginx/conf.d/dx-online.conf');
  writeFileSync(`${state}/active.json`, JSON.stringify({ sha: oldSha, port: 3201 }));
  run('openssl', ['req', '-x509', '-nodes', '-newkey', 'rsa:2048', '-keyout', '/tmp/release.key', '-out', '/usr/local/share/ca-certificates/dx-release.crt', '-days', '1', '-subj', '/CN=dxerp.org.cn', '-addext', 'subjectAltName=DNS:dxerp.org.cn', '-addext', 'basicConstraints=critical,CA:TRUE'], { stdio: 'ignore' });
  run('update-ca-certificates', [], { stdio: 'ignore' }); certificate = readFileSync('/usr/local/share/ca-certificates/dx-release.crt');
  const template = readFileSync(`${source}/infra/nginx/dx-rework.conf.example`, 'utf8').replaceAll('__DX_REWORK_SERVER_NAME__', 'dxerp.org.cn').replaceAll('__DX_REWORK_TLS_CERT__', '/usr/local/share/ca-certificates/dx-release.crt').replaceAll('__DX_REWORK_TLS_KEY__', '/tmp/release.key');
  writeFileSync(`${state}/nginx-template.conf`, template);
  for (const [generation, port] of [[oldSha, 3201], [newSha, 3203]]) run(node, [`${tool}/scripts/deploy/render-online-nginx.mjs`, `${state}/nginx-template.conf`, `${state}/${generation}.conf`, `${root}/frontend/releases/${generation}`, String(port)]);
  writeFileSync('/etc/nginx/nginx.conf', 'user www-data; worker_processes 1; pid /run/nginx.pid; events { worker_connections 1024; } http { include /etc/nginx/mime.types; include /etc/nginx/conf.d/dx-online.conf; }\n');
  symlinkSync(`${state}/${oldSha}.conf`, '/etc/nginx/conf.d/dx-online.conf');
  user('start-online-slot.sh', 'start', oldSha, '3201');
  run('nginx', ['-t']); run('nginx', [], { stdio: 'ignore' });
  console.log('EXERCISE old readiness');
  await wait(async () => { try { return (await http('/health/ready')).status === 200; } catch { return false; } }, 'old API readiness');
  if (process.env.DX_RELEASE_FETCH_CHECK === '1' || process.env.DX_RELEASE_SSH_RECOVERY_CHECK === '1') {
    // A real SSH Git server in this disposable container replaces github.com
    // through its explicit Docker host mapping. These keys never leave it.
    run('useradd', ['-m', '-s', '/usr/bin/git-shell', 'git']);
    run('passwd', ['-d', 'git']);
    mkdirSync('/home/git/lizhonghao31-crypto', { recursive: true });
    run('git', ['config', '--system', '--add', 'safe.directory', '/isolated-git']);
    run('git', ['clone', '--bare', '--no-local', '/isolated-git', '/home/git/lizhonghao31-crypto/dx-rework.git']);
    mkdirSync('/home/dxrework/.ssh', { mode: 0o700 });
    run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', '/home/dxrework/.ssh/github_dx_rework']);
    mkdirSync('/home/git/.ssh', { mode: 0o700 });
    cpSync('/home/dxrework/.ssh/github_dx_rework.pub', '/home/git/.ssh/authorized_keys');
    run('chmod', ['0600', '/home/git/.ssh/authorized_keys']);
    run('chown', ['-R', 'git:git', '/home/git']);
    mkdirSync('/run/sshd', { recursive: true });
    run('/usr/sbin/sshd', ['-E', '/tmp/isolated-sshd.log', '-o', 'PasswordAuthentication=no', '-o', 'UsePAM=no', '-o', 'AllowUsers=git'], { stdio: 'ignore' });
    writeFileSync('/home/dxrework/.ssh/known_hosts', run('ssh-keyscan', ['-t', 'ed25519', 'github.com']));
    run('chown', ['-R', 'dxrework:dxrework', '/home/dxrework/.ssh']);
  }
  if (process.env.DX_RELEASE_INSTALL_CHECK === '1') {
    // Exercise the genuine root installer from this clean audited checkout.
    // Its first installation and retries must not reload nginx or alter requests.
    const originalTemplate = readFileSync(`${state}/nginx-template.conf`);
    unlinkSync('/etc/nginx/conf.d/dx-online.conf');
    writeFileSync('/etc/nginx/conf.d/dx-online.conf', originalTemplate);
    rmSync(state, { recursive: true });
    writeFileSync('/usr/local/bin/dx-rework-deploy', '#!/bin/bash\nexit 0\n', { mode: 0o755 });
    if (process.env.DX_RELEASE_FETCH_CHECK === '1') {
      run('bash', [`${source}/scripts/deploy/install-update-entries.sh`, sha, '606349c084ee4c1cce9983fc667abe8393d2af29', node, '/etc/nginx/conf.d/dx-online.conf']);
      if (!existsSync('/usr/local/bin/dx-rework-update') || !existsSync('/usr/local/bin/dx-acceptance')) throw Error('bound two-branch bootstrap did not install fixed entries');
      console.log('REAL_SSH_TWO_BRANCH_BOOTSTRAP_PASS');
    }
    const install = () => run('bash', [`${source}/scripts/deploy/install-online-entry.sh`, node, '/etc/nginx/conf.d/dx-online.conf']);
    install(); install();
    unlinkSync('/usr/local/bin/dx-rework-maintenance-update');
    install();
    if (!existsSync('/usr/local/bin/dx-rework-maintenance-update') || readFileSync(`${state}/phase`, 'utf8').trim() !== 'installed-unconverted' || (await http('/version')).value.gitSha !== oldSha) throw Error('installer retry changed service or failed to recover wrapper');
    for (const [generation, port] of [[oldSha, 3201], [newSha, 3203]]) run(node, [`${tool}/scripts/deploy/render-online-nginx.mjs`, `${state}/nginx-template.conf`, `${state}/${generation}.conf`, `${root}/frontend/releases/${generation}`, String(port)]);
    unlinkSync('/etc/nginx/conf.d/dx-online.conf');
    symlinkSync(`${state}/${oldSha}.conf`, '/etc/nginx/conf.d/dx-online.conf');
    console.log('REAL_ROOT_INSTALL_RETRY_AND_PARTIAL_WRAPPER_RECOVERY_PASS');
  }
  console.log('EXERCISE initial QC write');
  await create('before');
  if (process.env.DX_RELEASE_FETCH_CHECK === '1') {
    cpSync(`${source}/package-lock.json`, `${root}/current/package-lock.json`);
    mkdirSync('/home/dxrework/.npm', { recursive: true });
    cpSync('/isolated-npm-cache/_cacache', '/home/dxrework/.npm/_cacache', { recursive: true });
    run('chown', ['-R', 'dxrework:dxrework', '/home/dxrework/.npm']);
    const output = run('mktemp', ['-d', '/tmp/dx-main-update.XXXXXX']).trim();
    run('chown', ['dxrework:dxrework', output]);
    user('prepare-online-candidate.sh', output);
    if (readFileSync(`${output}/CANDIDATE_SHA`, 'utf8').trim() !== sha || (await http('/version')).value.gitSha !== oldSha) throw Error('full source preparation disturbed old service or returned wrong SHA');
    console.log('REAL_SSH_FULL_FETCH_BUILD_PACKAGE_REGISTER_PASS');
  }
  if (!historical) {
  const round = async (candidate, candidatePort, expectRollback, invalidConfig = false, interruptPrepared = false) => {
    const active = JSON.parse(readFileSync(`${state}/active.json`, 'utf8'));
    const style = `RELEASE-LONG-${orders.length}`, batch = randomUUID(), key = randomUUID();
    await database.query('INSERT INTO receiving_batches(receiving_batch_id,style_no,created_by,delivery_note_quantity) VALUES($1,$2,$3,1)', [batch, style, qc]);
    await blocker.query('BEGIN'); await blocker.query('SELECT pg_advisory_xact_lock(hashtext($1))', [style]);
    const input = { receivingBatchId: batch, styleNo: style };
    const long = http('/api/rework-orders/drafts', 'POST', input, key);
    await wait(async () => (await database.query("SELECT count(*)::int n FROM pg_stat_activity WHERE application_name='dx-rework-api' AND wait_event_type='Lock'")).rows[0].n > 0, 'accepted in-flight QC write');
    writeFileSync(`${state}/previous-active.json`, JSON.stringify(active));
    writeFileSync(`${state}/previous-config`, `${state}/${active.sha}.conf`);
    writeFileSync(`${state}/candidate-sha`, candidate); writeFileSync(`${state}/candidate-port`, String(candidatePort));
    writeFileSync(`${state}/old-workers.json`, run(node, [`${tool}/scripts/deploy/nginx-workers.mjs`]));
    if (invalidConfig) {
      writeFileSync(`${state}/${candidate}.conf`, readFileSync(`${state}/${candidate}.conf`, 'utf8') + '\ninvalid_release_directive;\n');
    } else if (expectRollback) {
      const config = readFileSync(`${state}/${candidate}.conf`, 'utf8');
      writeFileSync(`${state}/${candidate}.conf`, config.replace(`proxy_pass http://127.0.0.1:${candidatePort}/version`, 'proxy_pass http://127.0.0.1:3199/version'));
    }
    writeFileSync(`${state}/phase`, interruptPrepared ? 'prepared' : 'switching');
    if (interruptPrepared) await blocker.query('SAVEPOINT ready_probe; LOCK TABLE schema_migrations IN ACCESS EXCLUSIVE MODE');
    let controller = startController();
    if (interruptPrepared) {
      await wait(async () => {
        const pid = run('runuser', ['-u', 'dxrework', '--', 'env', `PATH=${process.env.PATH}`, 'pm2', 'pid', `dx-rework-api-${candidatePort}`], { cwd: '/home/dxrework' }).trim();
        return /^\d+$/.test(pid) && Number(pid) > 0 && readFileSync(`${state}/phase`, 'utf8').trim() === 'prepared';
      }, 'prepared candidate is actually running before interruption');
      controller.child.kill('SIGKILL');
      const killed = await controller.done;
      if (killed.signal !== 'SIGKILL') throw Error('prepared controller interruption did not occur');
      await blocker.query('ROLLBACK TO SAVEPOINT ready_probe');
      if (process.env.DX_RELEASE_FETCH_CHECK === '1' || process.env.DX_RELEASE_SSH_RECOVERY_CHECK === '1') {
        const repository = '/home/git/lizhonghao31-crypto/dx-rework.git';
        const git = (...args) => run('git', ['-c', `safe.directory=${repository}`, '-C', repository, ...args], { env: { ...process.env, GIT_AUTHOR_NAME: 'isolated-release-test', GIT_AUTHOR_EMAIL: 'isolated@example.invalid', GIT_COMMITTER_NAME: 'isolated-release-test', GIT_COMMITTER_EMAIL: 'isolated@example.invalid' } });
        const tree = git('rev-parse', `${sha}^{tree}`).trim();
        const advanced = git('commit-tree', tree, '-p', sha, '-m', 'isolated concurrent main advance').trim();
        git('update-ref', 'refs/heads/main', advanced);
      }
      await wait(async () => { try { run('flock', ['-n', `${root}/locks/release.lock`, 'true']); return true; } catch { return false; } }, 'interrupted controller descendants release deployment lock');
      controller = startController();
    }
    for (let i = 0; i < 20; i += 1) { await create(`${expectRollback ? 'rollback' : 'switch'}-${i}`); }
    if (controller.child.exitCode !== null) throw Error(`controller stopped before old accepted request drained: ${JSON.stringify(await controller.done)}`);
    await blocker.query('ROLLBACK');
    const response = await long;
    if (response.status !== 201) throw Error(`accepted old request lost: ${JSON.stringify(response)}`);
    orders.push({ key, input, id: response.value.reworkOrderId });
    const result = await controller.done;
    if (expectRollback ? result.code === 0 : result.code !== 0) throw Error(`unexpected transition result: ${JSON.stringify(result)}`);
    const expected = expectRollback ? active.sha : candidate;
    if ((await http('/version')).value.gitSha !== expected) throw Error('public generation mismatch');
    await create('after-round');
    return result;
  };
  await round(newSha, 3203, false, false, true);
  user('start-online-slot.sh', 'start', oldSha, '3201');
  await wait(async () => { try { return JSON.parse(run('curl', ['-fsS', 'http://127.0.0.1:3201/version'])).gitSha === oldSha; } catch { return false; } }, 'rollback candidate');
  await round(oldSha, 3201, true);
  user('start-online-slot.sh', 'start', oldSha, '3201');
  await wait(async () => { try { return JSON.parse(run('curl', ['-fsS', 'http://127.0.0.1:3201/version'])).gitSha === oldSha; } catch { return false; } }, 'invalid-config candidate readiness');
  run(node, [`${tool}/scripts/deploy/render-online-nginx.mjs`, `${state}/nginx-template.conf`, `${state}/${oldSha}.conf`, `${root}/frontend/releases/${oldSha}`, '3201']);
  await round(oldSha, 3201, true, true);
  }
  const maintenanceRound = async (failure, interruptStop = false) => {
    const backupMustFail = failure === 'backup';
    const candidate = historical ? newSha : oldSha;
    const active = JSON.parse(readFileSync(`${state}/active.json`, 'utf8'));
    writeFileSync(`${state}/previous-active.json`, JSON.stringify(active));
    writeFileSync(`${state}/previous-active-nginx.conf`, readFileSync(`/etc/nginx/conf.d/dx-online.conf`));
    writeFileSync(`${state}/candidate-sha`, candidate);
    run(node, [`${tool}/scripts/deploy/render-main-maintenance.mjs`, `${state}/nginx-template.conf`, `${state}/maintenance.conf`]);
    writeFileSync(`${state}/maintenance-workers.json`, run(node, [`${tool}/scripts/deploy/nginx-workers.mjs`]));
    const originalWorkers = readFileSync(`${state}/maintenance-workers.json`, 'utf8');
    writeFileSync(`${state}/phase`, 'maintenance-prepared');
    mkdirSync(`${root}/backups/postgres`, { recursive: true });
    run('chown', [backupMustFail ? 'root:root' : 'dxrework:dxrework', `${root}/backups/postgres`]);
    run('chmod', [backupMustFail ? '0500' : '0700', `${root}/backups/postgres`]);
    const beforeHistory = (await database.query('SELECT * FROM schema_migrations ORDER BY version')).rows;
    let accepted;
    if (historical && failure === 'backup') {
      const batch = randomUUID(), key = randomUUID(), style = 'RELEASE-HISTORICAL-DRAIN';
      await database.query('INSERT INTO receiving_batches(receiving_batch_id,style_no,created_by,delivery_note_quantity) VALUES($1,$2,$3,1)', [batch, style, qc]);
      await blocker.query('BEGIN'); await blocker.query('SELECT pg_advisory_xact_lock(hashtext($1))', [style]);
      const input = { receivingBatchId: batch, styleNo: style };
      accepted = { input, key, done: http('/api/rework-orders/drafts', 'POST', input, key) };
      await wait(async () => (await database.query("SELECT count(*)::int n FROM pg_stat_activity WHERE application_name='dx-rework-api' AND wait_event_type='Lock'")).rows[0].n > 0, 'historical accepted QC write');
    }
    if (failure === 'ddl') await blocker.query('BEGIN; LOCK TABLE cutting_orders IN SHARE MODE');
    console.log(`EXERCISE maintenance failure=${failure} interruptStop=${interruptStop}`);
    let controller = startController('update-main-maintenance.sh');
    if (interruptStop) {
      await wait(async () => readFileSync(`${state}/phase`, 'utf8').trim() === 'maintenance-drained', 'journal before actual old runtime stop');
      controller.child.kill('SIGKILL');
      const killed = await controller.done;
      if (killed.signal !== 'SIGKILL') throw Error('maintenance stop interruption did not occur');
      await wait(async () => { try { run('flock', ['-n', `${root}/locks/release.lock`, 'true']); return true; } catch { return false; } }, 'interrupted stop finishes and releases deployment lock');
      controller = startController('update-main-maintenance.sh');
    }
    if (accepted) {
      console.log('EXERCISE historical accepted write awaiting maintenance');
      await wait(async () => { try { await http('/version'); return false; } catch (error) { return error.message.startsWith('HTTP 503'); } }, 'controlled maintenance rejects new production requests');
      if (controller.child.exitCode !== null) throw Error('historical API stopped before accepted write drained');
      process.kill(-controller.child.pid, 'SIGKILL');
      const killed = await controller.done;
      if (killed.signal !== 'SIGKILL') throw Error('maintenance drain interruption did not occur');
      await wait(async () => { try { run('flock', ['-n', `${root}/locks/release.lock`, 'true']); return true; } catch { return false; } }, 'killed drain process group releases deployment lock');
      controller = startController('update-main-maintenance.sh');
      await setTimeout(250);
      if (readFileSync(`${state}/maintenance-workers.json`, 'utf8') !== originalWorkers || controller.child.exitCode !== null) throw Error('maintenance retry overwrote receipt or stopped before accepted request drained');
      await blocker.query('ROLLBACK');
      const response = await accepted.done;
      if (response.status !== 201) throw Error('historical accepted QC write lost');
      orders.push({ key: accepted.key, input: accepted.input, id: response.value.reworkOrderId });
    }
    const result = await controller.done;
    if (readFileSync(`${state}/maintenance-workers.json`, 'utf8') !== originalWorkers) throw Error('original maintenance worker receipt overwritten');
    const afterHistory = (await database.query('SELECT * FROM schema_migrations ORDER BY version')).rows;
    for (const row of beforeHistory) {
      if (JSON.stringify(afterHistory.find(value => value.version === row.version)) !== JSON.stringify(row)) throw Error('historical migration receipt changed');
    }
    if (failure === 'ddl') await blocker.query('ROLLBACK');
    if (failure !== 'none' ? result.code === 0 : result.code !== 0) throw Error(`maintenance result: ${JSON.stringify(result)}`);
    const expected = failure !== 'none' ? active.sha : candidate;
    if ((await http('/version')).value.gitSha !== expected) throw Error('maintenance recovery generation mismatch');
    await create(backupMustFail ? 'backup-recovered' : 'maintenance-completed');
  };
  await maintenanceRound('backup');
  if (historical) await maintenanceRound('ddl');
  await maintenanceRound('none', true);
  for (const order of orders) {
    const response = await http('/api/rework-orders/drafts', 'POST', order.input, order.key);
    if (response.status !== 201 || response.value.reworkOrderId !== order.id || response.headers['idempotency-replayed'] !== 'true') throw Error('cross-generation idempotency replay changed an order');
  }
  const count = (await database.query('SELECT count(*)::int n FROM rework_orders WHERE created_by=$1', [qc])).rows[0].n;
  if (count !== orders.length) throw Error('acknowledged order count drift');
  const summary = { sourceSha: sha, generationLabelsSynthetic: true, database: 'PostgreSQL13 isolated marked database', api: 'real compiled server/QC HTTP route/Acceptance test identity provider', acknowledgedUniqueOrders: orders.length, persistedOrders: count, crossGenerationReplays: orders.length, longAcceptedWritesDrained: historical ? 1 : 3, quiescentBackupFailureRecovery: 'PASS', sameSchemaMaintenance: 'PASS', real0222MaintenanceRuntime: historical ? 'PASS_REAL_B7_APPLICATION_TO_0222' : 'NOT_EXERCISED', real0222LockFailureOldRuntimeRecovery: historical ? 'PASS' : 'NOT_EXERCISED', onlineSwitch: historical ? 'NOT_EXERCISED' : 'PASS', injectedPublicProbeFailureRollback: historical ? 'NOT_EXERCISED' : 'PASS', invalidNginxResumeRecovery: historical ? 'NOT_EXERCISED' : 'PASS', preparedCandidateCrashRecovery: historical ? 'NOT_EXERCISED' : 'PASS', maintenanceStopCrashRecovery: 'PASS', maintenanceDrainCrashRecovery: historical ? 'PASS' : 'NOT_EXERCISED', originalMaintenanceReceiptPreserved: 'PASS', concurrentMainAdvanceIgnoredDuringRecovery: (process.env.DX_RELEASE_FETCH_CHECK === '1' || process.env.DX_RELEASE_SSH_RECOVERY_CHECK === '1') ? 'PASS' : 'NOT_EXERCISED', rootInstallerRetry: process.env.DX_RELEASE_INSTALL_CHECK === '1' ? 'PASS' : 'NOT_EXERCISED', isolatedRealSshBootstrapAndPackaging: process.env.DX_RELEASE_FETCH_CHECK === '1' ? 'PASS' : 'NOT_EXERCISED', ecsInstallation: 'NOT_EXERCISED' };
  console.log(JSON.stringify(summary));
} finally {
  try { await blocker.query('ROLLBACK'); } catch { /* May already be closed. */ }
  try { run('runuser', ['-u', 'dxrework', '--', 'env', '-i', 'HOME=/home/dxrework', `PATH=${process.env.PATH}`, 'pm2', 'delete', 'all']); } catch { /* Test startup may have failed. */ }
  try { run('nginx', ['-s', 'quit']); } catch { /* May not have started. */ }
  await blocker.end(); await database.end(); await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end();
}
