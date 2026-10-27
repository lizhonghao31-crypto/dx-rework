import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {createRequire} from 'node:module';import {runInNewContext} from 'node:vm';
import {describe,it,expect} from 'vitest';
const sha='a'.repeat(40);
describe('Acceptance PM2 immutable generation',()=>{
 it.each([false,true])('pins live and restart paths independently of current (explicit recovery=%s)',explicit=>{
  const root=mkdtempSync(join(tmpdir(),'acceptance-stable-'));
  try{const release=join(root,'releases',sha),directory=join(release,'infra/pm2');mkdirSync(directory,{recursive:true});writeFileSync(join(release,'release-manifest.json'),JSON.stringify({gitSha:sha,appBasePath:'/acceptance/'}));
   const source=readFileSync('infra/pm2/ecosystem.acceptance.config.cjs','utf8').replace('/opt/dx-rework-acceptance',root),module={exports:{} as {apps:Array<{cwd:string;script:string}>}};
   runInNewContext(source,{module,require:createRequire(import.meta.url),__dirname:explicit?join(root,'tools/infra/pm2'):directory,process:{env:explicit?{DX_REWORK_ACCEPTANCE_RELEASE_SHA:sha}:{}}});
   expect(module.exports.apps[0]?.cwd).toBe(release);expect(module.exports.apps[0]?.script).toBe(join(release,'scripts/deploy/start-acceptance-api.sh'));
  }finally{rmSync(root,{recursive:true,force:true});}
 });
 it('rejects arbitrary paths, mismatched manifests and a missing explicit recovery pin',()=>{
  const root=mkdtempSync(join(tmpdir(),'acceptance-bad-path-'));
  try{const directory=join(root,'releases',sha,'infra/pm2');mkdirSync(directory,{recursive:true});writeFileSync(join(root,'releases',sha,'release-manifest.json'),JSON.stringify({gitSha:'b'.repeat(40),appBasePath:'/acceptance/'}));
   const source=readFileSync('infra/pm2/ecosystem.acceptance.config.cjs','utf8').replace('/opt/dx-rework-acceptance',root);
   for(const [here,env]of [[directory,{}],[join(root,'tools/infra/pm2'),{}],[directory,{DX_REWORK_ACCEPTANCE_RELEASE_SHA:'../current'}]] as const)expect(()=>runInNewContext(source,{module:{exports:{}},require:createRequire(import.meta.url),__dirname:here,process:{env}})).toThrow();
  }finally{rmSync(root,{recursive:true,force:true});}
 });
});
