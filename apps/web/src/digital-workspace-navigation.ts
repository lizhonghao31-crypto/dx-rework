/** Route-only adapter. Existing domain URLs and authorization remain authoritative. */
export function digitalWorkspaceActive(active: string, search: string): string {
  const workspace = new URLSearchParams(search).get("workspace");
  if (active === "开发与大货办理" && workspace === "designer") return "digital-designer";
  if (active === "生产管理座舱") {
    if (workspace === "settings") return "digital-settings";
    if (workspace === "pattern") return "digital-pattern";
    if (workspace === "preparation") return "digital-pattern";
    if (workspace === "factory") return "digital-factory";
  }
  return active;
}
