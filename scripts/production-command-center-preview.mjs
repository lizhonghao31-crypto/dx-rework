// Build the accepted production command-center UI as an offline real-component fixture.
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const output = resolve(process.argv[2] ?? "production-command-center-preview");
await mkdir(output, { recursive: true });

await build({
  configFile: false,
  root,
  define: { "import.meta.env.BASE_URL": '"/"', "process.env.NODE_ENV": '"production"' },
  resolve: { alias: { "@dx-rework/ui": join(root, "packages/ui/src/index.tsx") } },
  plugins: [react()],
  build: {
    outDir: join(output, "assets"),
    lib: {
      entry: join(root, "tests/fixtures/production-command-center-preview.tsx"),
      name: "ProductionCommandCenterPreview",
      formats: ["iife"],
      fileName: "preview",
    },
  },
});

const files = await readdir(join(output, "assets"));
const css = files.find(file => file.endsWith(".css"));
const js = files.find(file => file.endsWith(".js"));
if (!css || !js) throw new Error("Production command-center preview assets were not generated");

await writeFile(
  join(output, "index.html"),
  `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>生产管理座舱视觉验收</title><style>${await readFile(join(output, "assets", css), "utf8")}</style></head><body><div id="root"></div><script>${(await readFile(join(output, "assets", js), "utf8")).replace(/<\/script/gi, "<\\/script")}</script></body></html>`,
);
