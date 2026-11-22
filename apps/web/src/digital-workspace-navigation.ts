export const DESIGNER_WORKSPACE_SECTIONS = ['create','workspace'] as const;
export type DesignerWorkspaceSection = typeof DESIGNER_WORKSPACE_SECTIONS[number];
export const DESIGNER_ORDER_AREAS = ['document','development','customer','handover','records','history'] as const;
export type DesignerOrderArea = typeof DESIGNER_ORDER_AREAS[number];

export function designerWorkspaceSection(query: URLSearchParams): DesignerWorkspaceSection {
  const values = query.getAll('section');
  const create = values.length === 1 && values[0] === 'create';
  const oldDraftLink = values.length === 0 && query.getAll('view').length === 1 && query.get('view') === 'draft';
  return create || oldDraftLink ? 'create' : 'workspace';
}

/** Route-only adapter. Existing domain URLs and authorization remain authoritative. */
export function digitalWorkspaceActive(active: string, search: string): string {
  if(active==="生产数据填报")return "实时生产看板";
  const query = new URLSearchParams(search), workspace = query.get("workspace");
  if (active === "开发与大货办理" && workspace === "designer")
    return designerWorkspaceSection(query)==='create' ? 'digital-designer-create' : 'digital-designer';
  if (active === "生产管理座舱") {
    if (workspace === "delivery") return "digital-delivery";
    if (workspace === "settings") return "digital-settings";
    if (workspace === "pattern") return "digital-pattern";
    if (workspace === "preparation") return "digital-pattern";
    if (workspace === "factory") return "digital-factory";
  }
  return active;
}
