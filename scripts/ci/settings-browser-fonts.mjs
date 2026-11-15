import {appendFileSync,copyFileSync,existsSync,mkdtempSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const projectRoot=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const xml=value=>value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');

/** Job-local Linux font support. Reuse the committed OFL font, without APT,
 * downloads, root installation, product CSS overrides or a metric tolerance.
 * The job temp directory stays available for all later native browser suites. */
export function prepareSettingsBrowserFonts({environment=process.env,root=projectRoot,platform=process.platform}={}){
 if(platform!=='linux')return null;
 const source=join(root,'apps/api/src/assets/contract-chinese.ttf'),content=readFileSync(source);
 if(!content.length)throw Error('Committed Chinese browser font is empty');
 const inherited=environment.FONTCONFIG_FILE?resolve(environment.FONTCONFIG_FILE):'/etc/fonts/fonts.conf';
 if(!existsSync(inherited))throw Error('Original fontconfig file is missing');
 const temporary=environment.RUNNER_TEMP??tmpdir();
 if(/[\r\n]/.test(temporary))throw Error('Invalid browser font temporary path');
 const directory=mkdtempSync(join(temporary,'dx-settings-browser-fonts-'));
 const fonts=join(directory,'fonts'),cache=join(directory,'cache'),config=join(directory,'fonts.conf');
 mkdirSync(fonts,{mode:0o700});mkdirSync(cache,{mode:0o700});copyFileSync(source,join(fonts,'contract-chinese.ttf'));
 writeFileSync(config,`<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig><include>${xml(inherited)}</include><dir>${xml(fonts)}</dir><cachedir>${xml(cache)}</cachedir></fontconfig>\n`,{mode:0o600});
 environment.FONTCONFIG_FILE=config;
 if(environment.GITHUB_ENV)appendFileSync(environment.GITHUB_ENV,`FONTCONFIG_FILE=${config}\n`);
 return {directory,config,family:'Noto Sans SC Thin',sourceSha256:createHash('sha256').update(content).digest('hex')};
}
