import {readFileSync,mkdtempSync,mkdirSync,writeFileSync,symlinkSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {describe,it,expect} from 'vitest';
import {checkHistory,assertVersion} from '../../scripts/deploy/acceptance-update-policy.mjs';

const manifest=JSON.parse(readFileSync('apps/api/src/platform/migration-manifest.json','utf8'));
const main=JSON.parse(readFileSync('tests/fixtures/migration-histories/main-99db5239.json','utf8'));
const digital=JSON.parse(readFileSync('tests/fixtures/migration-histories/digital-da6590cc.json','utf8'));
describe('fixed Acceptance update policy',()=>{
  it('validates the frozen code-history fixtures (not现场 exports) before allowing migration',()=>{
    expect(checkHistory({...main,database:'dx_rework'},manifest,'production')).toMatchObject({status:'compatible',applied:220});
    expect(checkHistory({...digital,database:'dx_rework_acceptance'},manifest,'acceptance').pending).toContain('0233_manual_contract_template_provenance');
    expect(()=>checkHistory({...main,database:'dx_rework'},manifest,'acceptance')).toThrow('environment mismatch');
    expect(()=>checkHistory({...digital,database:'dx_rework_acceptance'},manifest,'production')).toThrow('environment mismatch');
    expect(()=>checkHistory({...main,database:'dx_rework'},manifest,'other')).toThrow('Unknown');
  });
  it('stops on missing, unknown or drifted live history',()=>{
    expect(()=>checkHistory({database:'dx_rework_acceptance',migrations:[]},manifest,'acceptance')).toThrow('empty');
    expect(()=>checkHistory({database:'dx_rework',migrations:[...main.migrations,{version:'9999_unknown',checksum:'f'.repeat(64)}]},manifest,'production')).toThrow('absent');
    expect(()=>checkHistory({database:'dx_rework',migrations:main.migrations.map((row:{version:string;checksum:string},i:number)=>i?row:{...row,checksum:'0'.repeat(64)})},manifest,'production')).toThrow('drift');
  });
  it('requires both running SHA and actual schema to match',()=>{
    const expected={gitSha:'a'.repeat(40),schemaVersion:'0233_manual_contract_template_provenance'};
    expect(()=>assertVersion(expected,expected)).not.toThrow();
    expect(()=>assertVersion({...expected,gitSha:'b'.repeat(40)},expected)).toThrow();
    expect(()=>assertVersion({...expected,schemaVersion:'0231_digital_order_closure'},expected)).toThrow();
  });
  it('rejects invalid command arguments before reading server configuration',()=>{
    for(const args of [['unexpected'],['update','main'],['update','a'.repeat(40),'extra']])expect(spawnSync('bash',['scripts/dx-acceptance.sh',...args],{encoding:'utf8'}).status).toBe(64);
  });
  it('rejects a shared workspace scope before touching its contents',()=>{
    const candidate=mkdtempSync(join(tmpdir(),'acceptance-deps-'));
    const production=mkdtempSync(join(tmpdir(),'acceptance-prod-'));
    try {
      mkdirSync(join(candidate,'node_modules'));
      writeFileSync(join(production,'sentinel'),'unchanged');
      symlinkSync(production,join(candidate,'node_modules','@dx-rework'));
      expect(()=>execFileSync(process.execPath,[resolve('scripts/deploy/prepare-acceptance-dependencies.mjs')],{cwd:candidate,stdio:'pipe'})).toThrow();
      expect(readFileSync(join(production,'sentinel'),'utf8')).toBe('unchanged');
    }finally{rmSync(candidate,{recursive:true,force:true});rmSync(production,{recursive:true,force:true});}
  });
  it('repairs copied workspace/bin links inside the candidate without modifying production files',()=>{
    const candidate=mkdtempSync(join(tmpdir(),'acceptance-deps-'));
    const production=mkdtempSync(join(tmpdir(),'acceptance-prod-deps-'));
    try {
      mkdirSync(join(candidate,'node_modules','@dx-rework'),{recursive:true});
      for(const name of ['contracts','config','domain','ui','api','web']){
        const group=['api','web'].includes(name)?'apps':'packages';
        mkdirSync(join(candidate,group,name),{recursive:true});
        writeFileSync(join(candidate,group,name,'package.json'),JSON.stringify({name:`@dx-rework/${name}`,version:'0.1.0'}));
        symlinkSync(production,join(candidate,'node_modules','@dx-rework',name));
      }
      mkdirSync(join(candidate,'node_modules','test-tool'),{recursive:true});
      writeFileSync(join(candidate,'node_modules','test-tool','package.json'),JSON.stringify({name:'test-tool',bin:{'test-tool':'cli.js'}}));
      writeFileSync(join(candidate,'node_modules','test-tool','cli.js'),'console.log("test")');
      mkdirSync(join(candidate,'node_modules','.bin'));
      writeFileSync(join(candidate,'node_modules','.bin','test-tool'),'stale copied launcher');
      writeFileSync(join(production,'sentinel'),'unchanged');
      execFileSync(process.execPath,[resolve('scripts/deploy/prepare-acceptance-dependencies.mjs')],{cwd:candidate});
      for(const name of ['contracts','config','domain','ui','api','web'])expect(realpathSync(join(candidate,'node_modules','@dx-rework',name))).toBe(join(candidate,['api','web'].includes(name)?'apps':'packages',name));
      expect(realpathSync(join(candidate,'node_modules','.bin','test-tool'))).toBe(join(candidate,'node_modules','test-tool','cli.js'));
      expect(readFileSync(join(production,'sentinel'),'utf8')).toBe('unchanged');
    } finally {rmSync(candidate,{recursive:true,force:true});rmSync(production,{recursive:true,force:true});}
  });
});
