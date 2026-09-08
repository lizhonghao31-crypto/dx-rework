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

export function assertAcceptanceDatabaseName(databaseName: string, source: string): string {
  const normalized = databaseName.trim();
  if (!isAcceptanceDatabaseName(normalized)) {
    throw new Error(`Acceptance lab refused ${source} database ${normalized || "<unknown>"}`);
  }
  return normalized;
}

export function assertAcceptanceDatabaseUrl(connectionUrl: string): string {
  return assertAcceptanceDatabaseName(
    databaseNameFromConnectionUrl(connectionUrl),
    "configured",
  );
}
