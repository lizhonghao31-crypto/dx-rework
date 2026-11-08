import {spawn,spawnSync,type ChildProcess} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync,lstatSync,mkdirSync,mkdtempSync,readFileSync,readlinkSync,realpathSync,renameSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer} from 'node:net';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {testExecutionConfig} from '../../scripts/test-execution-config.mjs';
vi.setConfig({testTimeout:testExecutionConfig.correctnessTimeoutMs,hookTimeout:testExecutionConfig.correctnessTimeoutMs});
const roots:string[]=[],a='a'.repeat(40),b='b'.repeat(40),c='c'.repeat(40),library=resolve('scripts/deploy/lib.sh');
const root=()=>{const value=mkdtempSync(join(tmpdir(),'dx-perf04-assets-'));roots.push(value);return value;};
const hash=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
const bash=(directory:string,commands:string,...args:string[])=>spawnSync('bash',['-e','-u','-o','pipefail','-c','source "$1"; shift; '+commands,'asset-test',library,...args],{
 cwd:process.cwd(),env:{...process.env,DX_REWORK_ROOT:directory},encoding:'utf8',timeout:15000,
});
function release(directory:string,sha:string,assets:Record<string,string>){
 for(const kind of ['api','frontend']){const target=join(directory,kind==='api'?'releases':'frontend/releases',sha);mkdirSync(target,{recursive:true});
  const files:Record<string,string>={'release-manifest.json':JSON.stringify({gitSha:sha})};
  if(kind==='frontend'){files['index.html']='<div id="root">TEST SPA</div>';for(const [name,body]of Object.entries(assets))files['assets/'+name]=body;}
  for(const [name,body]of Object.entries(files)){mkdirSync(resolve(target,name,'..'),{recursive:true});writeFileSync(join(target,name),body);}
  writeFileSync(join(target,'SHA256SUMS'),Object.entries(files).map(([name,body])=>hash(body)+'  '+name+'\n').join(''));
 }
}
const active=(directory:string,sha:string)=>{const result=bash(directory,'generation="$(ensure_generation "$1")"; ensure_active_aliases; atomic_link "$generation" "$DX_ROOT/active"',sha);expect(result.status,result.stderr+result.stdout).toBe(0);};
afterEach(()=>{for(const directory of roots.splice(0)){expect(directory.startsWith(join(tmpdir(),'dx-perf04-assets-'))).toBe(true);expect(realpathSync(directory)).toBe(directory);rmSync(directory,{recursive:true});}});
describe('bounded previous public frontend assets',()=>{
 it('points only to the previous verified generation without changing or copying immutable release files',()=>{
  const directory=root();release(directory,a,{'page-old.js':'old module','shared.js':'old shared'});release(directory,b,{'page-new.js':'new module','shared.js':'new shared'});active(directory,a);
  const before=readFileSync(join(directory,'frontend/releases',a,'SHA256SUMS'));
  const result=bash(directory,'retain_previous_frontend_assets "$1"',b);expect(result.status,result.stderr+result.stdout).toBe(0);active(directory,b);
  expect(lstatSync(join(directory,'frontend/previous-assets')).isSymbolicLink()).toBe(true);expect(readlinkSync(join(directory,'frontend/previous-assets'))).toBe(join(directory,'frontend/releases',a,'assets'));
  expect(readFileSync(join(directory,'frontend/previous-assets/page-old.js'),'utf8')).toBe('old module');expect(readFileSync(join(directory,'frontend/current/assets/shared.js'),'utf8')).toBe('new shared');
  expect(readFileSync(join(directory,'frontend/releases',a,'SHA256SUMS'))).toEqual(before);
  expect(bash(directory,'assert_release "$DX_ROOT/frontend/releases/$1" "$1"',a).status).toBe(0);
 });
 it('does not overwrite compatibility on an idempotent activation and restores it after a failed switch',()=>{
  const directory=root();for(const sha of [a,b,c])release(directory,sha,{['page-'+sha[0]+'.js']:sha});active(directory,a);
  expect(bash(directory,'retain_previous_frontend_assets "$1"',b).status).toBe(0);active(directory,b);
  const previous=join(directory,'frontend/releases',a,'assets');expect(bash(directory,'retain_previous_frontend_assets "$1"',b).status).toBe(0);expect(readlinkSync(join(directory,'frontend/previous-assets'))).toBe(previous);
  expect(bash(directory,'retain_previous_frontend_assets "$1"',c).status).toBe(0);expect(readlinkSync(join(directory,'frontend/previous-assets'))).toBe(join(directory,'frontend/releases',b,'assets'));
  active(directory,b);expect(bash(directory,'restore_previous_frontend_assets "$1"',previous).status).toBe(0);expect(readlinkSync(join(directory,'frontend/previous-assets'))).toBe(previous);
 });
 it('rejects an unrelated pointer or corrupt old asset before changing any active generation',()=>{
  const directory=root();release(directory,a,{'page.js':'original'});active(directory,a);const unrelated=join(directory,'unrelated');mkdirSync(unrelated);symlinkSync(unrelated,join(directory,'frontend/previous-assets'));
  expect(bash(directory,'retain_previous_frontend_assets "$1"',b).status).not.toBe(0);expect(readlinkSync(join(directory,'frontend/previous-assets'))).toBe(unrelated);expect(readlinkSync(join(directory,'active'))).toBe(join(directory,'generations',a));
  rmSync(join(directory,'frontend/previous-assets'));writeFileSync(join(directory,'frontend/releases',a,'assets/page.js'),'corrupt');expect(bash(directory,'retain_previous_frontend_assets "$1"',b).status).not.toBe(0);expect(existsSync(join(directory,'frontend/previous-assets'))).toBe(false);
 });
 it('handles first activation and removes only its own validated pointer when restoring an absent predecessor',()=>{
  const directory=root();release(directory,a,{'page.js':'original'});expect(bash(directory,'retain_previous_frontend_assets "$1"',a).status).toBe(0);expect(existsSync(join(directory,'frontend/previous-assets'))).toBe(false);
  active(directory,a);expect(bash(directory,'retain_previous_frontend_assets "$1"',b).status).toBe(0);expect(bash(directory,'restore_previous_frontend_assets ""').status).toBe(0);
  expect(existsSync(join(directory,'frontend/previous-assets'))).toBe(false);expect(readFileSync(join(directory,'frontend/releases',a,'assets/page.js'),'utf8')).toBe('original');
 });
 it('follows the served source frontend even when a stale packaged generation remains',()=>{
  const directory=root();release(directory,a,{'page.js':'stale packaged module'});release(directory,b,{'page.js':'served source module'});active(directory,a);
  mkdirSync(join(directory,'frontend/source-releases'));renameSync(join(directory,'frontend/releases',b),join(directory,'frontend/source-releases',b));
  rmSync(join(directory,'frontend/current'));symlinkSync(join(directory,'frontend/source-releases',b),join(directory,'frontend/current'));
  expect(bash(directory,'retain_previous_frontend_assets "$1"',c).status).toBe(0);
  expect(readFileSync(join(directory,'frontend/previous-assets/page.js'),'utf8')).toBe('served source module');
  expect(readlinkSync(join(directory,'active'))).toBe(join(directory,'generations',a));
  expect(bash(directory,'previous_frontend_asset_target').stdout.trim()).toBe(join(directory,'frontend/source-releases',b,'assets'));
 });
 it('does not invent checksum verification or mutate an older source release without one',()=>{
  const directory=root();release(directory,a,{'page.js':'legacy served source module'});mkdirSync(join(directory,'frontend/source-releases'));renameSync(join(directory,'frontend/releases',a),join(directory,'frontend/source-releases',a));
  rmSync(join(directory,'frontend/source-releases',a,'SHA256SUMS'));symlinkSync(join(directory,'frontend/source-releases',a),join(directory,'frontend/current'));
  expect(bash(directory,'retain_previous_frontend_assets "$1"',b).status).toBe(0);
  expect(existsSync(join(directory,'frontend/previous-assets'))).toBe(false);expect(existsSync(join(directory,'frontend/source-releases',a,'SHA256SUMS'))).toBe(false);
  expect(readFileSync(join(directory,'frontend/current/assets/page.js'),'utf8')).toBe('legacy served source module');
 });
});

const nginx=process.env.DX_REWORK_TEST_NGINX??(existsSync('/usr/sbin/nginx')?'/usr/sbin/nginx':null);
const location=(text:string,start:string)=>{const begin=text.indexOf(start);if(begin<0)throw Error('Original Nginx location not found: '+start);let depth=0,end=begin;for(let i=text.indexOf('{',begin);i<text.length;i++){if(text[i]==='{')depth++;if(text[i]==='}'&&--depth===0){end=i+1;break;}}return text.slice(begin,end);};
const port=async()=>{const server=createServer();await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();if(!address||typeof address==='string')throw Error('Owned local port unavailable');await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));return address.port;};
async function stop(child:ChildProcess){
 if(!child.pid||child.exitCode!==null||child.signalCode!==null)return;
 await new Promise<void>(resolve=>{const timer=setTimeout(()=>child.kill('SIGKILL'),3000);child.once('exit',()=>{clearTimeout(timer);resolve();});child.kill('SIGQUIT');});
}
(nginx?describe:describe.skip)('real Nginx current/previous asset routing',()=>{
 for(const fixture of [
  {file:'infra/nginx/dx-rework.conf.example',prefix:'/rework',base:'/opt/dx-rework',fallback:'@dx_rework_previous_asset'},
  {file:'infra/nginx/dx-rework-shared-paths.conf.example',prefix:'/rework',base:'/opt/dx-rework',fallback:'@dx_rework_previous_asset'},
  {file:'infra/nginx/dx-rework-acceptance.conf.example',prefix:'',base:'/opt/dx-rework-acceptance',fallback:'@dx_acceptance_previous_asset'},
  {file:'infra/nginx/dx-rework-acceptance-shared-paths.conf.example',prefix:'/acceptance',base:'/opt/dx-rework-acceptance',fallback:'@dx_acceptance_previous_asset'},
 ])it(fixture.file+' serves one prior module, prefers the current hash and returns a plain404 for unknown assets',async()=>{
  const directory=root();release(directory,a,{'old-module.js':'export const generation="old";','shared.js':'export const generation="old";'});release(directory,b,{'current-module.js':'export const generation="current";','shared.js':'export const generation="current";'});active(directory,a);expect(bash(directory,'retain_previous_frontend_assets "$1"',b).status).toBe(0);active(directory,b);
  const original=readFileSync(fixture.file,'utf8'),assetLocation=location(original,'location ^~ '+fixture.prefix+'/assets/ {'),fallback=location(original,'location '+fixture.fallback+' {');
  const blocks=(assetLocation+'\n'+fallback).replaceAll(fixture.base,directory).replace(/if \(-f [^)]+\) \{ return 503; \}/g,'').replace(/access_log[^;]+;/g,'access_log off;');
  const listener=await port(),configuration=join(directory,'nginx.conf');mkdirSync(join(directory,'nginx'),{recursive:true});
  writeFileSync(configuration,`worker_processes 1; error_log stderr; pid ${directory}/nginx.pid; events { worker_connections 64; } http { client_body_temp_path ${directory}/body; proxy_temp_path ${directory}/proxy; fastcgi_temp_path ${directory}/fastcgi; uwsgi_temp_path ${directory}/uwsgi; scgi_temp_path ${directory}/scgi; types { application/javascript js; } access_log off; server { listen 127.0.0.1:${listener}; root ${directory}/frontend/current; ${blocks} location / { return 200 '<div id="root">TEST SPA</div>'; } } }`);
  const checked=spawnSync(nginx!,['-t','-p',directory+'/nginx/','-c',configuration],{encoding:'utf8'});expect(checked.status,checked.stderr).toBe(0);
  // A single foreground process stays in this owned test process group; no
  // detached master/workers can survive a failed or interrupted parent runner.
  const child=spawn(nginx!,['-p',directory+'/nginx/','-c',configuration,'-g','daemon off; master_process off;'],{stdio:['ignore','pipe','pipe']});let diagnostics='',spawnFailed=false;child.stderr?.on('data',data=>{diagnostics+=String(data);});child.on('error',error=>{spawnFailed=true;diagnostics+=error.message;});
  try{const base='http://127.0.0.1:'+listener+fixture.prefix+'/assets/';let ready=false;
   const deadline=performance.now()+6000;for(let i=0;i<50&&performance.now()<deadline;i++){try{const response=await fetch(base+'current-module.js',{signal:AbortSignal.timeout(1000)});if(response.ok){ready=true;break;}}catch{/* Only owned loopback startup; bounded100ms below. */}if(spawnFailed||child.exitCode!==null)break;await new Promise(resolve=>setTimeout(resolve,100));}
   expect(ready,diagnostics).toBe(true);const previous=await fetch(base+'old-module.js');expect(await previous.text()).toContain('generation="old"');expect(previous.headers.get('x-content-type-options')).toBe('nosniff');expect(previous.headers.get('cache-control')).toContain('immutable');expect(await (await fetch(base+'shared.js')).text()).toContain('generation="current"');
   const missing=await fetch(base+'missing-module.js');expect(missing.status).toBe(404);expect(await missing.text()).not.toContain('id="root"');expect((await fetch(base+'release-manifest.json')).status).toBe(404);
  }finally{await stop(child);}
 });
});
