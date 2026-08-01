import path from "node:path";

export const ROUTE_ID = "BASE-04";
export const PREVIEW_ROOT = "/opt/dx-rework/previews";
export const COMMENT_MARKER = "<!-- dx-rework-pr-preview -->";
export const ROUTES = [
  "/ui/management", "/ui/supervisor", "/ui/tasks",
  "/ui/tasks/RW-2026-0728-003", "/ui/qc/new",
  "/ui/piecework/collective", "/system/foundation",
];

const STATUS_LABELS = {
  "built-disabled": "构建成功；部署未启用",
  deployed: "部署成功",
  "deploy-failed": "部署失败",
  cleaned: "清理完成",
  "cleanup-failed": "清理失败",
};

export function previewBase(prNumber) {
  if (!/^[1-9][0-9]*$/.test(String(prNumber))) throw new Error("invalid PR number");
  return `/pr-${prNumber}/`;
}

export function previewDirectory(prNumber) {
  const directory = `${PREVIEW_ROOT}${previewBase(prNumber)}`.replace(/\/$/, "");
  return assertSafeRemoteDirectory(directory);
}

export function assertSafeRemoteDirectory(directory) {
  if (!/^\/opt\/dx-rework\/previews\/pr-[1-9][0-9]*$/.test(directory)) {
    throw new Error(`refusing unsafe preview directory: ${directory}`);
  }
  return directory;
}

export function manifest({ prNumber, headSha, runId, buildStatus = "success", checksum = null }) {
  if (!/^[0-9a-f]{40}$/.test(headSha)) throw new Error("Head SHA must be a full 40 character lowercase SHA");
  if (!/^[1-9][0-9]*$/.test(String(runId))) throw new Error("run ID must be a positive integer");
  return {
    routeId: ROUTE_ID,
    githubPrNumber: Number(prNumber),
    headSha,
    githubRunId: String(runId),
    buildStatus,
    basePath: previewBase(prNumber),
    checksum,
  };
}

export function commentBody({ prNumber, headSha, runId, state, url }) {
  previewBase(prNumber);
  if (!/^[0-9a-f]{40}$/.test(headSha)) throw new Error("invalid Head SHA");
  if (!/^[1-9][0-9]*$/.test(String(runId))) throw new Error("invalid run ID");
  if (!Object.hasOwn(STATUS_LABELS, state)) throw new Error("invalid preview state");
  if (state === "deployed" && !/^https:\/\//.test(url ?? "")) throw new Error("a real HTTPS URL is required for deployed state");
  if (state !== "deployed" && url) throw new Error("URL is only valid for a real deployment");
  const status = state === "deployed" ? `${STATUS_LABELS[state]}：${url}` : STATUS_LABELS[state];
  return `${COMMENT_MARKER}\n## BASE-04 PR Preview\n\n- PR: #${prNumber}\n- Head SHA: \`${headSha}\`\n- Run ID: \`${runId}\`\n- 状态: ${status}\n`;
}

export function canReplaceComment(currentBody, expectedHeadSha) {
  const current = currentBody?.match(/Head SHA: `([0-9a-f]{40})`/)?.[1];
  return !current || current === expectedHeadSha;
}

export function canPublishStatus({ currentHead, currentState, expectedHead, expectedState }) {
  return currentHead === expectedHead && currentState === expectedState;
}

export function routeArtifactPath(dist, route) {
  return path.join(dist, route.replace(/^\//, ""), "index.html");
}
