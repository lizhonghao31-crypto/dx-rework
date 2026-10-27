import {readFile,lstat} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
const root='/opt/dx-rework-acceptance';
const dump='/home/dxacceptance/.pm2/dump.pm2';
export function inspectAcceptanceRuntime(rows,sha){
 if(!/^[0-9a-f]{40}$/.test(sha)||!Array.isArray(rows)||rows.length!==1||rows[0]?.name!=='dx-rework-acceptance-api')throw Error('Acceptance PM2 identity must contain only its isolated API');
 const env=rows[0].pm2_env??rows[0],release=`${root}/releases/${sha}`;
 if(env.status!=='online'||env.pm_cwd!==release||env.pm_exec_path!==`${release}/scripts/deploy/start-acceptance-api.sh`)throw Error('Acceptance PM2 runtime/restart paths do not match the immutable generation');
 return {sha,cwd:env.pm_cwd,script:env.pm_exec_path,status:env.status};
}
export async function verifyAcceptanceRuntime(sha,saved=false){
 const live=inspectAcceptanceRuntime(JSON.parse(execFileSync('pm2',['jlist'],{encoding:'utf8',timeout:10000,stdio:['ignore','pipe','pipe']})),sha);
 if(saved){if((await lstat(dump)).isSymbolicLink())throw Error('Acceptance PM2 saved state cannot be a symlink');inspectAcceptanceRuntime(JSON.parse(await readFile(dump,'utf8')),sha);}
 return {...live,saved};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const [sha,mode]=process.argv.slice(2);if(process.argv.length!==4||!['live','saved'].includes(mode))throw Error('Usage: acceptance-runtime-state.mjs SHA live|saved');
 process.stdout.write(JSON.stringify(await verifyAcceptanceRuntime(sha,mode==='saved'))+'\n');
}
