import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,readdirSync,rmSync,statSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {prepareSettingsBrowserFonts} from './settings-browser-fonts.mjs';

test('Linux native browser font setup retains inherited config, uses only the committed font and exports job-local support',()=>{
 const directory=mkdtempSync(join(tmpdir(),'dx-font-test-&-'));
 try{
  const inherited=join(directory,'base&fonts.conf'),githubEnv=join(directory,'github-env');writeFileSync(inherited,'<fontconfig/>');
  const environment={RUNNER_TEMP:directory,FONTCONFIG_FILE:inherited,GITHUB_ENV:githubEnv,TEST_PRESERVED:'yes'};
  const value=prepareSettingsBrowserFonts({environment,platform:'linux'});
  assert.equal(environment.FONTCONFIG_FILE,value.config);assert.equal(environment.TEST_PRESERVED,'yes');
  const xml=readFileSync(value.config,'utf8');assert.ok(xml.includes(inherited.replaceAll('&','&amp;')));assert.ok(xml.includes('<cachedir>'));assert.ok(xml.includes('<dir>'));
  assert.deepEqual(readFileSync(join(value.directory,'fonts/contract-chinese.ttf')),readFileSync('apps/api/src/assets/contract-chinese.ttf'));
  assert.match(value.sourceSha256,/^[a-f0-9]{64}$/);assert.equal(value.family,'Noto Sans SC Thin');
  assert.equal(readFileSync(githubEnv,'utf8'),`FONTCONFIG_FILE=${value.config}\n`);
  assert.equal(statSync(value.config).mode&0o777,0o600);assert.deepEqual(readdirSync(join(value.directory,'fonts')),['contract-chinese.ttf']);
 }finally{rmSync(directory,{recursive:true,force:true});}
});
test('missing or empty committed glyph font and invalid inherited configuration fail before exporting readiness',()=>{
 const directory=mkdtempSync(join(tmpdir(),'dx-font-negative-'));
 try{
  const environment={RUNNER_TEMP:directory,FONTCONFIG_FILE:join(directory,'missing.conf'),GITHUB_ENV:join(directory,'not-created')};
  assert.throws(()=>prepareSettingsBrowserFonts({environment,platform:'linux'}),/fontconfig file is missing/);
  assert.throws(()=>prepareSettingsBrowserFonts({environment,root:directory,platform:'linux'}),/ENOENT/);
  mkdirSync(join(directory,'apps/api/src/assets'),{recursive:true});writeFileSync(join(directory,'apps/api/src/assets/contract-chinese.ttf'),'');
  assert.throws(()=>prepareSettingsBrowserFonts({environment,root:directory,platform:'linux'}),/font is empty/);
  assert.equal(environment.FONTCONFIG_FILE,join(directory,'missing.conf'));
  assert.ok(!readdirSync(directory).some(name=>name.startsWith('dx-settings-browser-fonts-')));
 }finally{rmSync(directory,{recursive:true,force:true});}
});
test('non-Linux preparation leaves the original platform font environment untouched',()=>{
 const environment={FONTCONFIG_FILE:'/original',GITHUB_ENV:'/not-written'};
 assert.equal(prepareSettingsBrowserFonts({environment,platform:'darwin'}),null);
 assert.deepEqual(environment,{FONTCONFIG_FILE:'/original',GITHUB_ENV:'/not-written'});
});
