export function normalizeBasePath(value: string | undefined): string {
  const path = value || "/";
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("//") || path.includes("?") || path.includes("#") || path.includes("\\")) throw new Error("VITE_BASE_PATH must be a local absolute path");
  return path.endsWith("/") ? path : `${path}/`;
}

export function createWebUrls(value: string | undefined) {
  const base = normalizeBasePath(value);
  return {
    base,
    pageUrl: (path = "") => `${base}${path.replace(/^\//, "")}`,
    apiUrl: (path = "") => `${base}api/${path.replace(/^\//, "")}`,
    apiProxyPrefix: `${base === "/" ? "" : base.slice(0, -1)}/api`,
  };
}

export function rewriteApiProxyPath(path: string, prefix: string): string {
  return path.startsWith(prefix) ? path.slice(prefix.length) || "/" : path;
}
