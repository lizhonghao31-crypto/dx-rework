import {it,expect} from 'vitest';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
it('passes the explicit adoption mode through the original private app config loader without changing execution or existing list mode',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'dx-fixed-config-')),file=join(directory,'app.env');
 try{await writeFile(file,'DIGITAL_TIMELINE_ADOPTION_MODE=fixed_v2\nDIGITAL_JOURNEY_LIST_READ_MODE=indexed\n',{mode:0o600});const result=spawnSync('bash',['-c','source scripts/deploy/lib.sh\nload_app_config\nprintf "%s %s" "$DIGITAL_TIMELINE_ADOPTION_MODE" "$DIGITAL_JOURNEY_LIST_READ_MODE"'],{cwd:process.cwd(),env:{...process.env,DX_REWORK_APP_ENV_FILE:file},encoding:'utf8'});expect(result.status,result.stderr).toBe(0);expect(result.stdout).toBe('fixed_v2 indexed');}finally{await rm(directory,{recursive:true,force:true});}
});
