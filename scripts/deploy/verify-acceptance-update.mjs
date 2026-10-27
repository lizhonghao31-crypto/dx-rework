import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {assertVersion} from './acceptance-update-policy.mjs';
import {verifyAcceptanceRuntime} from './acceptance-runtime-state.mjs';
const [candidate,productionReceipt]=process.argv.slice(2);
if(!candidate||!productionReceipt||process.argv.length!==4)throw Error('Candidate and pinned production receipt are required');
const expected=JSON.parse(await readFile(`${candidate}/api/release-manifest.json`,'utf8'));
const frontend=JSON.parse(await readFile(`${candidate}/frontend/release-manifest.json`,'utf8'));
assertVersion(frontend,expected);
const runtime=await verifyAcceptanceRuntime(expected.gitSha);
if(frontend.schemaChecksum!==expected.schemaChecksum)throw Error('Frontend schema checksum mismatch');
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
const helper=fileURLToPath(new URL('./production-runtime-health.py',import.meta.url));
const production=JSON.parse(execFileSync('python3',[helper,'check','--receipt',productionReceipt],{encoding:'utf8',timeout:12000,stdio:['ignore','pipe','pipe']}));
process.stdout.write(JSON.stringify({status:'verified',gitSha:expected.gitSha,schema:expected.schemaVersion,runtime,production_port:production.port,production_sha:production.sha,production:'ready'})+'\n');
