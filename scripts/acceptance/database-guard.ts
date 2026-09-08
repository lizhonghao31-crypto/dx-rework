const ACCEPTANCE_DATABASE_TOKEN = /(?:^|[_-])(?:accept(?:ance)?|uat|test)(?:[_-]|$)/i;

export function isAcceptanceDatabaseName(databaseName: string): boolean {
  const normalized = databaseName.trim();
  return normalized.length > 0 && ACCEPTANCE_DATABASE_TOKEN.test(normalized);
}

export function databaseNameFromConnectionUrl(connectionUrl: string): string {
  const parsed = new URL(connectionUrl);
  const pathname = decodeURIComponent(parsed.pathname).replace(/^\/+/, "");
  if (!pathname || pathname.includes("/")) return "";
  return pathname;
}
