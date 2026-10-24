// These nodes record business facts and release successors through development adapters.
// Keep other task kinds eligible for their existing generic completion action.
const developmentBusinessTasks = new Set([
  "development_materials", "development_material_recheck", "development_material_supply",
  "development_pattern", "development_external_pattern", "development_cutting", "development_craft_dispatch",
  "development_printing", "development_embroidery", "development_print_embroidery",
  "development_craft_confirmation", "development_sewing_transfer", "development_sewing",
  "development_washing_dispatch", "development_washing", "development_pre_wash_check", "development_tail_check",
  "development_confirmation", "development_shipping",
]);

export const developmentTaskNeedsBusinessPage = (taskKind: string): boolean => developmentBusinessTasks.has(taskKind);
