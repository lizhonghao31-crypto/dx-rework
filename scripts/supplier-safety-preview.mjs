// Isolated UI regression harness. No real session or supplier write.
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
const root = resolve(import.meta.dirname, "..");
const output = resolve(process.argv[2] ?? "supplier-safety-preview");
await mkdir(output, { recursive: true });
await build({ configFile: false, root, define: { "import.meta.env.BASE_URL": '"/rework/"', "process.env.NODE_ENV": '"production"' },
  resolve: { alias: { "@dx-rework/ui": join(root, "packages/ui/src/index.tsx") } },
  plugins: [react(), { name: "supplier-safety-offline-fixture", enforce: "pre",
    resolveId(id) {
      if (id === "./auth.js") return "\0supplier-auth";
      if (id === "./components.js") return "\0supplier-shell";
      if (id === "./system-management-navigation.js") return "\0supplier-nav";
      if (id === "@dx-rework/contracts/business-display") return join(root, "packages/contracts/src/business-display.ts");
    },
    load(id) {
      if (id === "\0supplier-auth") return 'export async function verifySession(){return {user:{id:"fixture-root",isRoot:true,capabilities:[],businessRoles:[]}}}';
      if (id === "\0supplier-shell") return "export function Shell({children}){return children;}";
      if (id === "\0supplier-nav") return "export function SystemManagementNavigation(){return null;}";
    },
  }],
  build: { outDir: join(output, "assets"), lib: { entry: join(root, "tests/fixtures/supplier-safety-preview.tsx"), name: "SupplierSafetyPreview", formats: ["iife"], fileName: "preview" } },
});
const files = await readdir(join(output, "assets"));
await writeFile(join(output, "frame.html"), `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>供应商操作安全回归</title><style>${await readFile(join(output, "assets", files.find(file => file.endsWith(".css"))), "utf8")}</style></head><body><div id="root"></div><script>${(await readFile(join(output, "assets", files.find(file => file.endsWith(".js"))), "utf8")).replace(/<\/script/gi, "<\\/script")}</script></body></html>`);

await writeFile(join(output, "index.html"), `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>供应商操作安全回归尺寸</title></head><body style="margin:0"><label>尺寸<select id="size">${[[1440,1024],[1280,800],[768,1024],[390,844],[360,800]].map(([width,height])=>`<option value="${width},${height}">${width} × ${height}</option>`).join("")}</select></label><iframe title="供应商操作安全回归" src="frame.html" style="display:block;border:0;width:1440px;height:1024px;margin:auto"></iframe><script>const select=document.querySelector('select'),frame=document.querySelector('iframe');select.addEventListener('change',()=>{const [width,height]=select.value.split(',');frame.style.width=width+'px';frame.style.height=height+'px';});</script></body></html>`);
