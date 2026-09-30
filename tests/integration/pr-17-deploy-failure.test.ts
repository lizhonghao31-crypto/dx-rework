import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";

const repositoryRoot = process.cwd();
const oldSha = "1111111111111111111111111111111111111111";
const newSha = "2222222222222222222222222222222222222222";

function writeExecutable(path: string, body: string): void {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

function writeRelease(root: string, sha: string): void {
  const api = join(root, "releases", sha);
  const frontend = join(root, "frontend", "releases", sha);
  for (const directory of [api, frontend]) {
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, "release-manifest.json"),
      `${JSON.stringify({ gitSha: sha, schemaVersion: "0032_fixture" })}\n`,
    );
    const checksum = spawnSync("sha256sum", ["release-manifest.json"], {
      cwd: directory,
      encoding: "utf8",
    });
    expect(checksum.status).toBe(0);
    writeFileSync(join(directory, "SHA256SUMS"), checksum.stdout);
  }
  mkdirSync(join(api, "scripts", "deploy"), { recursive: true });
  mkdirSync(join(api, "apps", "api", "src", "platform"), { recursive: true });
  mkdirSync(join(api, "infra", "pm2"), { recursive: true });
  writeFileSync(
    join(api, "apps", "api", "src", "platform", "migration-manifest.json"),
    '{"migrations":[]}\n',
  );
  writeFileSync(join(api, "infra", "pm2", "ecosystem.config.cjs"), "module.exports={}\n");

  const generation = join(root, "generations", sha);
  mkdirSync(generation, { recursive: true });
  symlinkSync(api, join(generation, "api"));
  symlinkSync(frontend, join(generation, "frontend"));
}

function makeActivationFixture(withPrevious: boolean): {
  root: string;
  env: NodeJS.ProcessEnv;
  pm2Log: string;
} {
  const root = mkdtempSync(join(tmpdir(), "pr17-activate-"));
  const fakeBin = join(root, "bin");
  const shared = join(root, "shared");
  mkdirSync(fakeBin, { recursive: true });
  mkdirSync(shared, { recursive: true });
  mkdirSync(join(root, "locks"), { recursive: true });
  mkdirSync(join(root, "frontend"), { recursive: true });
  mkdirSync(join(root, "generations"), { recursive: true });
  writeRelease(root, oldSha);
  writeRelease(root, newSha);

  symlinkSync(join(root, "active", "api"), join(root, "current"));
  symlinkSync(join(root, "active", "frontend"), join(root, "frontend", "current"));
  if (withPrevious) {
    symlinkSync(join(root, "generations", oldSha), join(root, "active"));
  }

  const realNode = process.execPath;
  const nodeBin = join(fakeBin, "node22");
  writeExecutable(
    nodeBin,
    `#!/usr/bin/env bash\nset -euo pipefail\nif [[ "\${1:-}" == */database-state.mjs ]]; then exit 0; fi\nexec "${realNode}" "$@"\n`,
  );

  const pm2Log = join(root, "pm2.log");
  const pm2Count = join(root, "pm2-count");
  writeFileSync(pm2Log, "");
  writeFileSync(pm2Count, "0\n");
  writeExecutable(
    join(fakeBin, "pm2"),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "${pm2Log}"
if [[ "\${1:-}" == jlist ]]; then
  printf '[{"name":"dx-rework-api","pm2_env":{"status":"online","pm_cwd":"${root}/current","pm_exec_path":"${root}/current/scripts/deploy/start-api.sh"}}]\n'
  exit 0
fi
if [[ "\${1:-}" == startOrReload ]]; then
  count="$(cat "${pm2Count}")"
  if [[ "$count" == 0 ]]; then
    printf '1\n' > "${pm2Count}"
    exit 42
  fi
fi
exit 0
`,
  );
  writeExecutable(join(fakeBin, "sudo"), "#!/usr/bin/env bash\nexit 0\n");
  writeExecutable(
    join(fakeBin, "curl"),
    `#!/usr/bin/env bash
set -euo pipefail
url="\${*: -1}"
if [[ "$url" == */version ]]; then
  sha="$(basename "$(readlink -f "${root}/active")")"
  printf '{"gitSha":"%s","expectedSchemaVersion":"0032_fixture","schemaVersion":"0032_fixture"}\n' "$sha"
fi
exit 0
`,
  );

  const nginxConfig = join(shared, "nginx.conf");
  const cert = join(shared, "cert.pem");
  const key = join(shared, "key.pem");
  writeFileSync(nginxConfig, "server_name rework.example.test;\n");
  writeFileSync(cert, "fixture\n");
  writeFileSync(key, "fixture\n");
  chmodSync(key, 0o600);
  writeFileSync(join(shared, ".env"), "DATABASE_URL=postgresql://fixture/fixture\n");
  writeFileSync(
    join(shared, "deploy.env"),
    [
      `DX_REWORK_NODE_BIN=${nodeBin}`,
      "DX_REWORK_NGINX_MODE=dedicated_vhost",
      "DX_REWORK_SERVER_NAME=rework.example.test",
      `DX_REWORK_TLS_CERT=${cert}`,
      `DX_REWORK_TLS_KEY=${key}`,
      `DX_REWORK_NGINX_CONFIG=${nginxConfig}`,
      "DX_REWORK_PROFILE=pilot",
      "",
    ].join("\n"),
  );
  chmodSync(join(shared, ".env"), 0o600);
  chmodSync(join(shared, "deploy.env"), 0o600);

  return {
    root,
    pm2Log,
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      DX_REWORK_ROOT: root,
      DX_REWORK_APP_ENV_FILE: join(shared, ".env"),
      DX_REWORK_DEPLOY_ENV_FILE: join(shared, "deploy.env"),
    },
  };
}

function runActivation(
  fixture: ReturnType<typeof makeActivationFixture>,
  allowPreviousRestore: boolean,
) {
  return spawnSync("bash", ["scripts/deploy/activate-release.sh", newSha], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: {
      ...fixture.env,
      DX_REWORK_ALLOW_PREVIOUS_RESTORE: String(allowPreviousRestore),
    },
  });
}

describe("PR-17 deployment failure recovery", () => {
  it("does not trust a forged inherited-lock environment variable", async () => {
    const root = mkdtempSync(join(tmpdir(), "pr17-lock-"));
    const marker = join(root, "locked");
    const holder = spawn(
      "bash",
      [
        "-c",
        `source scripts/deploy/lib.sh; acquire_lock '${root}/release.lock'; : > '${marker}'; sleep 10`,
      ],
      {
        cwd: repositoryRoot,
        env: { ...process.env, DX_REWORK_ROOT: root },
        stdio: "ignore",
      },
    );
    try {
      for (let attempt = 0; attempt < 100 && !existsSync(marker); attempt += 1) {
        await delay(20);
      }
      expect(existsSync(marker)).toBe(true);
      const contender = spawnSync(
        "bash",
        ["-c", `source scripts/deploy/lib.sh; acquire_lock '${root}/release.lock'`],
        {
          cwd: repositoryRoot,
          encoding: "utf8",
          env: {
            ...process.env,
            DX_REWORK_ROOT: root,
            DX_REWORK_LOCK_FD: "37",
          },
        },
      );
      expect(contender.status).not.toBe(0);
    } finally {
      holder.kill("SIGTERM");
    }
  });

  it("restores the previous generation when target PM2 activation fails", () => {
    const fixture = makeActivationFixture(true);
    const result = runActivation(fixture, true);
    expect(result.status).not.toBe(0);
    expect(readFileSync(fixture.pm2Log, "utf8")).toMatch(/startOrReload[\s\S]*startOrReload/);
    expect(readlinkSync(join(fixture.root, "active"))).toBe(join(fixture.root, "generations", oldSha));
    expect(readlinkSync(join(fixture.root, "current"))).toBe(join(fixture.root, "active", "api"));
    expect(readlinkSync(join(fixture.root, "frontend", "current"))).toBe(
      join(fixture.root, "active", "frontend"),
    );
    expect(existsSync(join(fixture.root, "shared", "release-switch.lock"))).toBe(false);
  });

  it("deactivates a failed first generation and stops the bad process", () => {
    const fixture = makeActivationFixture(false);
    const result = runActivation(fixture, true);
    expect(result.status).not.toBe(0);
    const log = readFileSync(fixture.pm2Log, "utf8");
    expect(log).toContain("startOrReload");
    expect(log).toContain("stop dx-rework-api");
    expect(existsSync(join(fixture.root, "active"))).toBe(false);
    expect(lstatSync(join(fixture.root, "current")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(fixture.root, "shared", "release-switch.lock"))).toBe(false);
  });

  it("retains the target generation under maintenance after schema change", () => {
    const fixture = makeActivationFixture(true);
    const result = runActivation(fixture, false);
    expect(result.status).not.toBe(0);
    expect(readFileSync(fixture.pm2Log, "utf8")).toMatch(/startOrReload[\s\S]*startOrReload/);
    expect(readlinkSync(join(fixture.root, "active"))).toBe(join(fixture.root, "generations", newSha));
    expect(existsSync(join(fixture.root, "shared", "release-switch.lock"))).toBe(true);
  });
});