import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {assertVersion} from './acceptance-update-policy.mjs';
const [candidate]=process.argv.slice(2);
const expected=JSON.parse(await readFile(`${candidate}/release-manifest.json`,'utf8'));
async function get(url) {
  const response=await fetch(url,{signal:AbortSignal.timeout(15000),headers:{'Cache-Control':'no-cache'}});
  if(!response.ok)throw Error(`HTTP ${response.status}: ${url}`);
  return response;
}
await get('http://127.0.0.1:3202/health/ready');
assertVersion(await (await get('http://127.0.0.1:3202/version')).json(),expected);
const origin='https://staging-api.dxerp.org.cn';
await get(`${origin}/acceptance/api/health/ready`);
assertVersion(await (await get(`${origin}/acceptance/api/version`)).json(),expected);
const html=await readFile(`${candidate}/frontend/index.html`,'utf8');
const served=await (await get(`${origin}/acceptance/index.html`)).text();
if(served!==html)throw Error('Public Acceptance HTML does not match candidate');
const assets=[...html.matchAll(/(?:src|href)=["'](\/acceptance\/assets\/[^"']+)["']/g)].map(match=>match[1]);
if(!assets.length)throw Error('No Acceptance static assets found');
const hash=data=>createHash('sha256').update(data).digest('hex');
for(const asset of new Set(assets)) {
  const relative=asset.slice('/acceptance/'.length);
  if(relative.includes('..')||!/^assets\/[A-Za-z0-9_.-]+$/.test(relative))throw Error('Invalid candidate asset path');
  const local=await readFile(`${candidate}/frontend/${relative}`);
  const remote=Buffer.from(await (await get(origin+asset)).arrayBuffer());
  if(hash(local)!==hash(remote))throw Error(`Public static asset mismatch: ${relative}`);
}
await get('http://127.0.0.1:3201/health/ready');
process.stdout.write(JSON.stringify({status:'verified',gitSha:expected.gitSha,schema:expected.schemaVersion,production_3201:'ready'})+'\n');
