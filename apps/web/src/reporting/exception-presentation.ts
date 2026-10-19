import { createWebUrls } from '../../url-contract.js';
const uuid='[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
/** Keep the report's original existing destination; target routes still enforce their own authority. */
export function exceptionRecordHref(value: unknown, base: string): string | null {
  if(typeof value!=='string'||!value.startsWith('/ui/')||value.includes('\\'))return null;
  const url=new URL(value,'https://local.invalid');
  if(url.origin!=='https://local.invalid'||url.hash||url.pathname!==value.split(/[?#]/)[0])return null;
  if(new RegExp(`^/ui/tasks(?:/${uuid})?$`,'i').test(url.pathname)&&!url.search)return createWebUrls(base).pageUrl(url.pathname);
  if(new RegExp(`^/ui/tasks/${uuid}$`,'i').test(url.pathname)&&[...url.searchParams.keys()].length===2&&url.searchParams.get('node')==='settlement_followup'&&new RegExp(`^${uuid}$`,'i').test(url.searchParams.get('case')??''))return createWebUrls(base).pageUrl(url.pathname)+url.search;
  return null;
}
