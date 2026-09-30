import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import { createWebUrls, rewriteApiProxyPath } from "./url-contract.js";

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, process.cwd(), "");
  const urls = createWebUrls(process.env.VITE_BASE_PATH ?? environment.VITE_BASE_PATH);
  return {
  base: urls.base,
  plugins: [react()],
  build: {
    outDir: "dist",
    sourcemap: true,
    cssTarget: "chrome61",
  },
  server: {
    port: 3200,
    strictPort: true,
    proxy: {
      [urls.apiProxyPrefix]: {
        target: "http://127.0.0.1:3201",
        changeOrigin: false,
        rewrite: (path) => rewriteApiProxyPath(path, urls.apiProxyPrefix),
      },
    },
  },
  };
});
