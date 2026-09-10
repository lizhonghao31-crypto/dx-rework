export function reworkReturnPath(search: string, source: unknown, fromTodos = false): string {
  for (const candidate of [new URLSearchParams(search).get('returnTo'), source]) {
    if (typeof candidate === 'string' && candidate.startsWith('/ui/') && !candidate.includes('\\') && !/^\/ui\/(tasks|my-tasks|responsibility)\//.test(candidate)) return candidate;
  }
  return fromTodos ? '/ui/my-tasks' : '/ui/tasks';
}
