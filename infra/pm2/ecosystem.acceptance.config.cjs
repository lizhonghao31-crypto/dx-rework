const root = "/opt/dx-rework-acceptance";

module.exports = {
  apps: [
    {
      name: "dx-rework-acceptance-api",
      cwd: `${root}/current`,
      script: `${root}/current/scripts/deploy/start-acceptance-api.sh`,
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
