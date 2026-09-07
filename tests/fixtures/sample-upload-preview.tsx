// Synthetic files and HTTP responses only; never imported by the application.
import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { SampleImageUpload } from "../../apps/web/src/sample-create-page.js";
import { Button, Surface } from "@dx-rework/ui";
import "../../packages/ui/src/tokens.css";
import "../../packages/ui/src/components.css";

let sequence = 0;
let rejectSecond = true;
const intents = new Map<string, { filename: string; mimeType: string; sizeBytes: number; sha256: string }>();
window.fetch = async (input, init = {}) => {
  const path = String(input);
  if (path.endsWith("/upload-intents")) {
    const metadata = JSON.parse(String(init.body));
    const attachmentId = `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`;
    intents.set(attachmentId, metadata);
    return Response.json({ attachmentId, objectKey: "synthetic", uploadMethod: "POST", uploadUrl: "https://fixture.invalid/upload", uploadFields: { key: attachmentId }, expiresAt: "2026-09-07T00:00:00Z" });
  }
  if (path === "https://fixture.invalid/upload") return new Response(null, { status: 204 });
  if (path.endsWith("/finalize")) {
    const attachmentId = path.split("/").at(-2)!;
    if (new Headers(init.headers).has("content-type") && init.body == null) return Response.json({ error: { code: "VALIDATION_ERROR", message: "Request validation failed" } }, { status: 400 });
    if (rejectSecond && sequence === 2) {
      rejectSecond = false;
      return Response.json({ error: { code: "STORAGE_UNAVAILABLE", message: "Object storage is temporarily unavailable" } }, { status: 503 });
    }
    return Response.json({ attachmentId, ...intents.get(attachmentId), status: "ready", createdAt: "2026-09-07T00:00:00Z" });
  }
  throw new Error("不在隔离样板请求白名单内");
};

function Preview() {
  const [files, setFiles] = useState<{ attachmentId: string; filename: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(0);
  const area = useRef<HTMLDivElement>(null);
  const select = () => {
    // Produce two valid tiny PNGs locally, then exercise the real file-input handler.
    const canvas = document.createElement("canvas"); canvas.width = 2; canvas.height = 2;
    canvas.getContext("2d")!.fillRect(0, 0, 2, 2);
    canvas.toBlob(blob => {
      if (!blob) return;
      const input = area.current?.querySelector("input[type=file]") as HTMLInputElement | null;
      if (!input || input.disabled) return;
      const transfer = new DataTransfer();
      for (const name of ["采购小票一.png", "采购小票二.png"]) transfer.items.add(new File([blob], name, { type: "image/png" }));
      input.files = transfer.files; input.dispatchEvent(new Event("change", { bubbles: true }));
    }, "image/png");
  };
  return <main style={{ maxWidth: 760, margin: "0 auto", padding: 16 }}>
    <h1>样衣小票上传回归</h1><p>隔离测试，不连接业务系统。第二张图片首次确认时模拟失败。</p>
    <Button disabled={busy} onClick={select}>选择两张测试图片</Button>
    <Surface><div ref={area}><SampleImageUpload label="上传采购小票" value={files} onChange={setFiles} disabled={false} onBusy={setBusy} onPending={setPending} /></div></Surface>
    <p role="status">已确认 {files.length} 张；上传申请 {sequence} 次</p>
    <Button disabled={busy || pending > 0 || !files.length}>提交建档并首次领用</Button>
  </main>;
}
createRoot(document.getElementById("root")!).render(<Preview />);
