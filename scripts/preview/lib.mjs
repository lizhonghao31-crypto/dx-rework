import path from "node:path";

export const ROUTE_ID = "BASE-04";
export const PREVIEW_ROOT = "/opt/dx-rework/previews";
export const ROUTES = [
  "/ui/management", "/ui/supervisor", "/ui/tasks",
  "/ui/tasks/RW-2026-0728-003", "/ui/qc/new",
  "/ui/piecework/collective", "/system/foundation",
];

export function previewBase(prNumber) {
  if (!/^[1-9][0-9]*$/.test(String(prNumber))) throw new Error("invalid PR number");
  return `/pr-${prNumber}/`;
}

export function previewDirectory(prNumber) {
  const directory = `${PREVIEW_ROOT}${previewBase(prNumber)}`.replace(/\/$/, "");
  if (!new RegExp(`^${PREVIEW_ROOT.replaceAll("/", "\\/")}\\/pr-[1-9][0-9]*$`).test(directory)) {
    throw new Error("refusing unsafe preview directory");
  }
  return directory;
}

export function assertSafeRemoteDirectory(directory) {
  if (!/^\/opt\/dx-rework\/previews\/pr-[1-9][0-9]*$/.test(directory)) {
    throw new Error(`refusing unsafe preview directory: ${directory}`);
  }
  return directory;
}

export function manifest({ prNumber, headSha, buildStatus = "success", checksum = null }) {
  if (!/^[0-9a-f]{40}$/.test(headSha)) throw new Error("Head SHA must be a full 40 character lowercase SHA");
  return { routeId: ROUTE_ID, githubPrNumber: Number(prNumber), headSha, buildStatus, basePath: previewBase(prNumber), checksum };
}

export function commentBody({ prNumber, headSha, state, url }) {
  if (!["built-disabled", "deployed", "cleaned"].includes(state)) throw new Error("invalid preview state");
  if (state !== "deployed" && url) throw new Error("URL is only valid for a real deployment");
  const status = state === "deployed" ? `部署成功：${url}` : state === "cleaned" ? "清理完成" : "构建成功；部署未启用";
  return `<!-- dx-rework-pr-preview -->\n## BASE-04 PR Preview\n\n- PR: #${prNumber}\n- Head SHA: \`${headSha}\`\n- 状态: ${status}\n`;
}

export function canReplaceComment(currentBody, expectedHeadSha) {
  const current = currentBody?.match(/Head SHA: `([0-9a-f]{40})`/)?.[1];
  return !current || current === expectedHeadSha;
}

export function routeArtifactPath(dist, route) {
  return path.join(dist, route.replace(/^\//, ""), "index.html");
}
