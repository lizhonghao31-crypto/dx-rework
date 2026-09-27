export function isMerchandiserOnly(roles: readonly string[] | undefined, isRoot: boolean | undefined): boolean {
  return isRoot !== true && roles?.length === 1 && roles[0] === "order_merchandiser";
}
