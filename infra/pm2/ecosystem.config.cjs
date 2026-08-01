module.exports = {
  apps: [
    {
      name: "dx-rework-api",
      cwd: "/opt/dx-rework/current",
      script: "apps/api/dist/server.js",
      interpreter: "/usr/bin/node",
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      max_memory_restart: "512M",
      kill_timeout: 10000,
      listen_timeout: 10000,
      time: true,
      out_file: "/opt/dx-rework/logs/api-out.log",
      error_file: "/opt/dx-rework/logs/api-error.log",
      merge_logs: true,
      env: {
        NODE_ENV: "production",
        HOST: "127.0.0.1",
        PORT: "3201",
        SERVICE_NAME: "dx-rework-api",
      },
    },
  ],
};
