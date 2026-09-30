// Build an offline fixture containing real UI components and synthetic HTTP only.
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
const root = resolve(import.meta.dirname, "..");
const output = resolve(process.argv[2] ?? "pattern-ux-preview");
await mkdir(output, { recursive: true });
await build({ configFile: false, root, define: { "import.meta.env.BASE_URL": '"/rework/"', "process.env.NODE_ENV": '"production"' },
  resolve: { alias: { "@dx-rework/ui": join(root, "packages/ui/src/index.tsx") } }, plugins: [react()],
  build: { outDir: join(output, "assets"), lib: { entry: join(root, "tests/fixtures/pattern-ux-preview.tsx"), name: "PatternUxPreview", formats: ["iife"], fileName: "preview" } },
});
const files = await readdir(join(output, "assets"));
await writeFile(join(output, "frame.html"), `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>打板隔离验收</title><style>${await readFile(join(output, "assets", files.find(file => file.endsWith(".css"))), "utf8")}</style></head><body><div id="root"></div><script>${(await readFile(join(output, "assets", files.find(file => file.endsWith(".js"))), "utf8")).replace(/<\/script/gi, "<\\/script")}</script></body></html>`);
await writeFile(join(output, "index.html"), `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>打板验收尺寸</title></head><body style="margin:0"><label>视口<select id="size">${["1440,1024", "1280,800", "768,1024", "390,844", "360,800"].map(size => `<option value="${size}">${size.replace(",", " × ")}</option>`).join("")}</select></label><iframe title="打板隔离验收" src="frame.html" style="display:block;border:0;width:1440px;height:1024px;margin:auto"></iframe><script>const select=document.querySelector('select'),frame=document.querySelector('iframe');select.addEventListener('change',()=>{const [width,height]=select.value.split(',');frame.style.width=width+'px';frame.style.height=height+'px';frame.src='frame.html';});</script></body></html>`);
