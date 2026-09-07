// Original-only comparison adapter. The icons build uses the real production Shell.
// Fail on source drift rather than silently changing the approved baseline.
export function navigationIconPreviewTransform(source) {
  const replacements = [
    ['<NavigationItem icon={<NavigationIcon route={entry.href} size={iconSize} />} active={active === entry.name}>', '<NavigationItem icon="•" active={active === entry.name}>'],
    ['<strong className="dx-navigation-group-label"><NavigationIcon group={group.name} size="primary" />{group.name}</strong>', '<strong>{group.name}</strong>'],
    ['<NavigationItem icon={<NavigationIcon route={entry.href} size="primary" />} active={isActive}>', '<NavigationItem icon={meta.glyph} active={isActive}>'],
    ['<b aria-hidden="true"><NavigationIcon group="更多" size="primary" /></b>', '<b aria-hidden="true">更</b>'],
    ['<h1><NavigationIcon route={headingRoute} group={badge} size="title" />{title}</h1>', '<h1>{title}</h1>'],
  ];
  let result = source;
  for (const [before, after] of replacements) {
    if (result.split(before).length !== 2) throw new Error(`Preview source drift: ${before}`);
    result = result.replace(before, after);
  }
  return result;
}
