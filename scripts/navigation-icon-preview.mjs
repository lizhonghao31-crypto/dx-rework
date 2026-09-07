import { build } from "vite";
import react from "@vitejs/plugin-react";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { navigationIconPreviewTransform } from "./navigation-icon-preview-transform.mjs";

export const previewAuth = `export async function verifySession(){const worker=document.body.dataset.role==='worker';return {status:'authorized',user:{id:'00000000-0000-4000-8000-000000000001',displayName:'图标样板用户',isRoot:!worker,businessRoles:worker?['worker']:['owner_group'],capabilities:worker?['todo:view','work:report']:['todo:view','sample:view_finance']}};} export function hasPageAccess(user){return user.isRoot;}`;
export const previewContracts = `export const TodoCountIndicatorSchema={parse:value=>value};export const formatBusinessDecimal=value=>new Intl.NumberFormat('zh-CN',{maximumFractionDigits:2}).format(value);`;
export const previewRefresh = `export function installTodoIndicatorRefresh(refresh){void refresh();return ()=>{};}`;
const root = resolve(import.meta.dirname, "..");
const output = resolve(process.argv[2] ?? "navigation-icon-preview");
await mkdir(output, { recursive: true });
for (const design of ["icons", "original"]) {
  const outDir = join(output, design);
  await build({ configFile: false, root, define: { "import.meta.env.BASE_URL": '"/rework/"', "process.env.NODE_ENV": '"production"' },
    resolve: { alias: { "@dx-rework/ui": join(root,"packages/ui/src/index.tsx") } },
    plugins: [react(), { name: "isolated-navigation-preview", enforce: "pre",
      resolveId(id) { if (["@dx-rework/contracts", "@dx-rework/contracts/business-display"].includes(id)) return "\0preview-contracts"; if (id === "./auth.js") return "\0preview-auth"; if(id === "./todo-indicator-refresh.js") return "\0preview-refresh"; },
      load(id) { if (id === "\0preview-auth") return previewAuth; if(id === "\0preview-contracts") return previewContracts; if(id === "\0preview-refresh") return previewRefresh; },
      transform(source,id) { if(design === "icons" && id.endsWith("/apps/web/src/components.tsx")) return navigationIconPreviewTransform(source); },
    }],
    build: { outDir, lib: { entry: join(root,"tests/fixtures/navigation-icon-preview.tsx"), name: "NavigationPreview", formats: ["iife"], fileName: "preview" }, minify: true },
  });
  const files = await readdir(outDir);
  const js = await readFile(join(outDir,files.find(name=>name.endsWith(".js"))),"utf8");
  const css = await readFile(join(outDir,files.find(name=>name.endsWith(".css"))),"utf8");
  for(const role of ["root","worker"]) await writeFile(join(output,`${design}-${role}.html`),`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>达兴导航图标样板</title><style>${css}</style></head><body data-design="${design}" data-role="${role}"><div id="root"></div><script>${js.replace(/<\/script/gi,"<\\/script")}</script></body></html>`);
}
const css=await readFile(join(root,"packages/ui/src/tokens.css"),"utf8")+await readFile(join(root,"packages/ui/src/components.css"),"utf8");
await writeFile(join(output,"index.html"),`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>达兴数字助手 · PR01 图标样板</title><style>${css}*{box-sizing:border-box}body{margin:0;font:14px/1.5 var(--dx-v2-font-family);color:var(--dx-v2-color-text);background:var(--dx-v2-color-bg-canvas)}.controls{display:flex;flex-wrap:wrap;gap:12px;align-items:center;padding:12px 16px;background:var(--dx-v2-color-surface)}label{display:flex;gap:8px;align-items:center}select{min-height:40px;font:inherit}iframe{display:block;border:0;margin:auto;background:var(--dx-v2-color-bg-canvas)}.viewport{overflow:visible}p{margin:4px 16px 12px;color:var(--dx-v2-color-text-secondary)}@media(max-width:600px){select{font-size:16px}.controls{gap:8px}}</style></head><body><div class="controls"><strong>导航图标样板</strong><label>尺寸<select id="size"><option value="auto">适应当前窗口</option>${[[1440,1024],[1280,800],[768,1024],[390,844],[360,800]].map(([w,h])=>`<option value="${w},${h}">${w} × ${h}</option>`).join("")}</select></label><label>对照<select id="design"><option value="icons">图标初稿</option><option value="original">现有原样</option></select></label><label>视角<select id="role"><option value="root">完整导航</option><option value="worker">工人示例</option></select></label></div><p>先确认图标样式。页面与数量均为合成示例；不连接正式系统，不修改任何业务记录。</p><div class="viewport"><iframe title="可点击导航图标样板"></iframe></div><script>const f=document.querySelector('iframe'),size=document.querySelector('#size'),design=document.querySelector('#design'),role=document.querySelector('#role');function render(){const [w,h]=size.value.split(',');f.style.width=w==='auto'?'100%':w+'px';f.style.height=w==='auto'?'1100px':h+'px';const target=design.value+'-'+role.value+'.html';if(f.getAttribute('src')!==target)f.src=target;}for(const e of [size,design,role])e.addEventListener('change',render);render();</script></body></html>`);
console.log(output);
