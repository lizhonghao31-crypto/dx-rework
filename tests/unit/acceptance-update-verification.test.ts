import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe,it,expect,vi} from 'vitest';
const productionProbe=vi.hoisted(()=>vi.fn());
vi.mock('node:child_process',()=>({execFileSync:productionProbe}));

describe('Acceptance public deployment verification',()=>{
  it.each(['valid','stale-api','stale-html','stale-asset','not-ready','production-not-ready'] as const)('checks %s without contacting a live environment',async scenario=>{
    vi.resetModules();
    const candidate=mkdtempSync(join(tmpdir(),'acceptance-verification-'));
    const argv=process.argv;
    const expected={gitSha:'a'.repeat(40),schemaVersion:'0233_manual_contract_template_provenance'};
    const html='<html><script type="module" src="/acceptance/assets/index-test.js"></script></html>';
    mkdirSync(join(candidate,'frontend','assets'),{recursive:true});
    mkdirSync(join(candidate,'api'));
    writeFileSync(join(candidate,'api','release-manifest.json'),JSON.stringify(expected));
    writeFileSync(join(candidate,'frontend','release-manifest.json'),JSON.stringify(expected));
    writeFileSync(join(candidate,'frontend','index.html'),html);
    writeFileSync(join(candidate,'frontend','assets','index-test.js'),'candidate-code');
    const calls:string[]=[];
    const productionReceipt=join(candidate,'production-runtime.json');
    productionProbe.mockReset();
    productionProbe.mockImplementation((command:string)=>{
      if(command==='pm2')return JSON.stringify([{name:'dx-rework-acceptance-api',pm2_env:{status:'online',pm_cwd:`/opt/dx-rework-acceptance/releases/${expected.gitSha}`,pm_exec_path:`/opt/dx-rework-acceptance/releases/${expected.gitSha}/scripts/deploy/start-acceptance-api.sh`}}]);
      if(scenario==='production-not-ready')throw Error('PRODUCTION_HEALTH_GUARD_FAILED');
      return JSON.stringify({port:3203,sha:'c'.repeat(40),source:'active-receipt',phase:'completed'});
    });
    vi.stubGlobal('fetch',vi.fn(async(url:string)=>{
      calls.push(url);
      if(scenario==='not-ready'&&url.includes('3202/health'))return new Response('',{status:503});
      if(url.endsWith('/version'))return Response.json(scenario==='stale-api'&&url.includes('https:')?{...expected,gitSha:'b'.repeat(40)}:expected);
      if(url.endsWith('/index.html'))return new Response(scenario==='stale-html'?'old-html':html);
      if(url.includes('/assets/'))return new Response(scenario==='stale-asset'?'old-code':'candidate-code');
      return Response.json({status:'ready'});
    }));
    process.argv=[process.execPath,'verify-acceptance-update.mjs',candidate,productionReceipt];
    try {
      const operation=import('../../scripts/deploy/verify-acceptance-update.mjs');
      if(scenario==='valid'){
        await expect(operation).resolves.toBeDefined();
        expect(productionProbe).toHaveBeenCalledWith('python3',[expect.stringContaining('/production-runtime-health.py'),'check','--receipt',productionReceipt],expect.objectContaining({timeout:12000}));
        expect(calls).not.toContain('http://127.0.0.1:3201/health/ready');
        expect(calls).toContain('https://staging-api.dxerp.org.cn/acceptance/assets/index-test.js');
      } else await expect(operation).rejects.toThrow();
    } finally {process.argv=argv;vi.unstubAllGlobals();rmSync(candidate,{recursive:true,force:true});}
  });
});
