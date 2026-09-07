// Isolated UI regression harness. No real session, object storage or sample write.
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
const root = resolve(import.meta.dirname, "..");
const output = resolve(process.argv[2] ?? "sample-upload-preview");
await mkdir(output, { recursive: true });
const contracts = `import {z} from 'zod';
export * from '${join(root, "packages/contracts/src/sample-create.ts")}';
export const UploadIntentResponseSchema=z.object({attachmentId:z.string().uuid(),objectKey:z.string(),uploadMethod:z.literal('POST'),uploadUrl:z.string().url(),uploadFields:z.record(z.string(),z.string()),expiresAt:z.string().datetime()});
export const AttachmentResponseSchema=z.object({attachmentId:z.string().uuid(),filename:z.string(),mimeType:z.string(),sizeBytes:z.number().int(),sha256:z.string().regex(/^[a-f0-9]{64}$/),status:z.enum(['pending','ready','rejected']),createdAt:z.string().datetime()});`;
await build({ configFile: false, root, define: { "import.meta.env.BASE_URL": '"/rework/"', "process.env.NODE_ENV": '"production"' },
  resolve: { alias: { "@dx-rework/ui": join(root, "packages/ui/src/index.tsx") } },
  plugins: [react(), { name: "sample-upload-offline-fixture", enforce: "pre",
    resolveId(id) { if (id === "./attachment-upload.js") return "\0sample-prepare"; if (id === "@dx-rework/contracts") return "\0sample-contracts"; if (id === "./components.js") return "\0sample-shell"; },
    load(id) { if (id === "\0sample-prepare") return `export {prepareImageUploadCandidate,uploadImageWithNormalizationRetry} from "${join(root, "apps/web/src/attachment-upload.ts")}"; export async function sha256Hex(){return "${"a".repeat(64)}";}`; if (id === "\0sample-contracts") return contracts; if (id === "\0sample-shell") return "export function Shell({children}){return children;} export function Header(){return null;}"; },
  }],
  build: { outDir: join(output, "assets"), lib: { entry: join(root, "tests/fixtures/sample-upload-preview.tsx"), name: "SampleUploadPreview", formats: ["iife"], fileName: "preview" } },
});
const files = await readdir(join(output, "assets"));
await writeFile(join(output, "frame.html"), `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>样衣上传回归</title><style>${await readFile(join(output, "assets", files.find(file => file.endsWith(".css"))), "utf8")}</style></head><body><div id="root"></div><script>${(await readFile(join(output, "assets", files.find(file => file.endsWith(".js"))), "utf8")).replace(/<\/script/gi, "<\\/script")}</script></body></html>`);

await writeFile(join(output, "index.html"), `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>样衣上传回归尺寸</title></head><body style="margin:0"><label>尺寸<select id="size"><option value="1440,1024">1440 × 1024</option><option value="390,844">390 × 844</option></select></label><iframe title="样衣上传回归" src="frame.html" style="display:block;border:0;width:1440px;height:1024px;margin:auto"></iframe><script>const select=document.querySelector('select'),frame=document.querySelector('iframe');select.addEventListener('change',()=>{const [width,height]=select.value.split(',');frame.style.width=width+'px';frame.style.height=height+'px';});</script></body></html>`);
