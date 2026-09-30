import { build } from "vite";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { resolve, join } from "node:path";

const output = resolve(process.argv[2] ?? "sample-ui-preview");
await mkdir(output, { recursive: true });
await build({ configFile: false, define: { "import.meta.env.BASE_URL": '"/"', "process.env.NODE_ENV": '"production"' },
  build: { outDir: join(output, "bundle"), lib: { entry: resolve("tests/fixtures/sample-ui-preview.tsx"), name: "SamplePreview", formats: ["iife"], fileName: "sample-preview" }, minify: true },
});
const names = await readdir(join(output, "bundle"));
const js = await readFile(join(output, "bundle", names.find(name => name.endsWith(".js"))), "utf8");
const css = await readFile(join(output, "bundle", names.find(name => name.endsWith(".css"))), "utf8");
const page = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body data-mode="managed" data-role="sample_designer"><div id="root"></div><script>${js.replace(/<\/script/gi, "<\\/script")}</script></body></html>`;
const harness = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>样衣 PR-2 固定数据布局验收</title></head><body style="margin:0"><div style="padding:8px;font:16px sans-serif"><label>验收宽度<select id="width">${[375,393,430,768,1440].map(n => `<option>${n}</option>`).join("")}</select></label> <label>页面<select id="mode">${["managed","pending","disposed","amounts","detail"].map(s=>`<option>${s}</option>`).join("")}</select></label> <label>角色<select id="role">${["sample_designer","sample_administrative","sample_finance","owner_group","root_superuser"].map(s=>`<option>${s}</option>`).join("")}</select></label> <strong>固定测试数据 · 离线组件验收</strong></div><iframe title="样衣验收页面" style="display:block;border:0;height:1100px" width="375"></iframe><script>const source=${JSON.stringify(page).replace(/<\/script/gi,"<\\/script")}; const f=document.querySelector('iframe'); function render(){f.width=document.getElementById('width').value;f.srcdoc=source.replace('data-mode="managed"','data-mode="'+document.getElementById('mode').value+'"').replace('data-role="sample_designer"','data-role="'+document.getElementById('role').value+'"');}document.querySelectorAll('select').forEach(s=>s.addEventListener('change',render));render();</script></body></html>`;
await writeFile(join(output, "index.html"), harness);
console.log(join(output, "index.html"));
