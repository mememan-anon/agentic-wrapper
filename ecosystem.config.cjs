module.exports = {
  apps: [
    {
      name: "api-zeno-finance",
      cwd: __dirname,
      script: "dist/server.js",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: "512M",
      merge_logs: true,
      out_file: "server.log",
      error_file: "server.err.log",
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
