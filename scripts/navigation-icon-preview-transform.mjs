// Preview-only adapter. Production source remains unchanged until sample approval.
// Replacements are explicit and fail on source drift; the fixture uses the real Shell.
export function navigationIconPreviewTransform(source) {
  const replacements = [
    ['const { apiUrl }', 'import { NavigationIcon } from "./navigation-icons.js";\nconst { apiUrl }'],
    ['<NavigationItem icon="•" active={active === entry.name}>', '<NavigationItem icon={<NavigationIcon route={entry.href} size={navigation.some(item => item.href === "/ui/orders") ? "primary" : "secondary"} />} active={active === entry.name}>'],
    ['<strong>{group.name}</strong>', '<strong className="dx-navigation-group-label"><NavigationIcon group={group.name} size="primary" />{group.name}</strong>'],
    ['<NavigationItem icon={meta.glyph} active={isActive}>', '<NavigationItem icon={<NavigationIcon route={entry.href} size="primary" />} active={isActive}>'],
    ['<b aria-hidden="true">更</b>', '<b aria-hidden="true"><NavigationIcon group="更多" size="primary" /></b>'],
    ['<h1>{title}</h1>', '<h1><NavigationIcon route={document.body.dataset.previewRoute} size="title" />{title}</h1>'],
  ];
  let result = source;
  for (const [before, after] of replacements) {
    if (result.split(before).length !== 2) throw new Error(`Preview source drift: ${before}`);
    result = result.replace(before, after);
  }
  return result;
}
