// PM2 loads .cjs synchronously; ESM imports are not supported in this file.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require("node:fs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require("node:path");
const root = "/opt/dx-rework-acceptance";
const pin = process.env.DX_REWORK_ACCEPTANCE_RELEASE_SHA;
if (pin !== undefined && !/^[0-9a-f]{40}$/.test(pin)) throw Error("Invalid Acceptance release pin");
const release = pin ? `${root}/releases/${pin}` : fs.realpathSync(path.resolve(__dirname, "../.."));
const sha = path.basename(release);
if (!/^[0-9a-f]{40}$/.test(sha) || release !== `${root}/releases/${sha}` || fs.realpathSync(release) !== release) throw Error("Acceptance PM2 requires an immutable release path");
const manifest = JSON.parse(fs.readFileSync(path.join(release, "release-manifest.json"), "utf8"));
if (manifest.gitSha !== sha || manifest.appBasePath !== "/acceptance/") throw Error("Acceptance PM2 release identity mismatch");

module.exports = {
  apps: [
    {
      name: "dx-rework-acceptance-api",
      cwd: release,
      script: `${release}/scripts/deploy/start-acceptance-api.sh`,
      interpreter: "/usr/bin/bash",
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      max_memory_restart: "512M",
      kill_timeout: 10000,
      listen_timeout: 10000,
      time: true,
      out_file: `${root}/logs/api-out.log`,
      error_file: `${root}/logs/api-error.log`,
      merge_logs: true,
      env: {
        DX_REWORK_ROOT: root,
        DX_REWORK_APP_ENV_FILE: `${root}/shared/.env`,
        DX_REWORK_DEPLOY_ENV_FILE: `${root}/shared/deploy.env`,
      },
    },
  ],
};
