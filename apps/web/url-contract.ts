export function normalizeBasePath(value: string | undefined): string {
  const path = value || "/";
  if (
    !path.startsWith("/")
    || path.startsWith("//")
    || path.includes("//")
    || path.includes("?")
    || path.includes("#")
    || path.includes("\\")
  ) {
    throw new Error("VITE_BASE_PATH must be a local absolute path");
  }
  return path.endsWith("/") ? path : `${path}/`;
}

type BrowserLocation = Readonly<{
  pathname: string;
  search: string;
}>;

const REWORK_ORDER_ID =
  "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

const pageReworkOrderId = (
  base: string,
  location: BrowserLocation | null,
): string | null => {
  if (!location) return null;
  const basePath = base === "/" ? "" : base.slice(0, -1);
  const relativePath = location.pathname.startsWith(basePath)
    ? location.pathname.slice(basePath.length) || "/"
    : location.pathname;
  const match = relativePath.match(
    new RegExp(`^/ui/tasks/(${REWORK_ORDER_ID})$`, "i"),
  );
  return match?.[1]
    ?? new URLSearchParams(location.search).get("rework");
};

export function resolveWebApiPath(
  path: string,
  base: string,
  location: BrowserLocation | null,
): string {
  const normalized = path.replace(/^\//, "");
  if (normalized !== "master-data/suppliers") return normalized;
  const reworkOrderId = pageReworkOrderId(base, location);
  return reworkOrderId
    ? `rework-orders/${reworkOrderId}/external-responsibilities/supplier-options`
    : normalized;
}

export function createWebUrls(value: string | undefined) {
  const base = normalizeBasePath(value);
  return {
    base,
    pageUrl: (path = "") => `${base}${path.replace(/^\//, "")}`,
    apiUrl: (
      path = "",
      location: BrowserLocation | null =
        typeof window === "undefined" ? null : window.location,
    ) => `${base}api/${resolveWebApiPath(path, base, location)}`,
    apiProxyPrefix: `${base === "/" ? "" : base.slice(0, -1)}/api`,
  };
}

export function rewriteApiProxyPath(path: string, prefix: string): string {
  return path.startsWith(prefix) ? path.slice(prefix.length) || "/" : path;
}
