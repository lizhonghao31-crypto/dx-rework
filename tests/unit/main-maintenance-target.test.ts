import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const prepare=readFileSync('scripts/deploy/prepare-online-candidate.sh','utf8');
const block=prepare.slice(prepare.indexOf('if [[ "$mode" != recovery'),prepare.indexOf('git -C "$repository" merge-base'));
const target='a'.repeat(40), other='b'.repeat(40);
const run=(mode:string,sha:string,expected:string)=>spawnSync('bash',['-c',
  'source scripts/deploy/lib.sh; mode="$1"; sha="$2"; export DX_REWORK_EXPECTED_MAIN_SHA="$3"; '+block,
  'fixture',mode,sha,expected],{encoding:'utf8'});
describe('maintenance exact approved target',()=>{
  it('freezes the fetched tree and reverifies it before Root code execution',()=>{
    const script=readFileSync('docs/operations/main-0226-update.sh','utf8');
    const freeze=script.indexOf('chown -R root:root "$repository"');
    const verify=script.indexOf('git_verified fsck --full --no-reflogs');
    const execute=script.indexOf('source "$repository/scripts/deploy/lib.sh"');
    expect(freeze).toBeGreaterThan(script.indexOf('git_remote checkout --quiet --detach "$target"'));
    expect(script.indexOf('chmod -R u=rwX,go=rX "$repository"')).toBeGreaterThan(freeze);
    expect(verify).toBeGreaterThan(freeze);
    expect(execute).toBeGreaterThan(verify);
    expect(script).toContain('git_verified status --porcelain --untracked-files=all');
    const delegated=script.slice(script.indexOf("<<'WORK_PREFLIGHT'"),script.indexOf('\nWORK_PREFLIGHT'));
    expect(delegated).not.toContain('ln -s');
    expect(delegated).not.toContain('unlink');
  });
  it('checks the fetched revision before archive, build, DDL or routing',()=>{
    expect(block).toContain('require_sha "$DX_REWORK_EXPECTED_MAIN_SHA"');
    expect(prepare.indexOf(block)).toBeLessThan(prepare.indexOf('git -C "$repository" archive'));
    expect(run('maintenance',target,target).status).toBe(0);
    expect(run('maintenance',target,other).status).not.toBe(0);
    expect(run('maintenance',target,other).stdout).toContain('running service untouched');
    expect(run('maintenance',target,'not-a-sha').status).not.toBe(0);
  });
  it('retains default entry compatibility and exact old-artifact recovery',()=>{
    expect(run('maintenance',target,'').status).toBe(0);
    expect(run('recovery',other,target).status).toBe(0);
    const controller=readFileSync('scripts/deploy/update-main-maintenance.sh','utf8');
    expect(controller).toContain('DX_REWORK_EXPECTED_MAIN_SHA="$expected_sha"');
    expect(controller).toContain('frozen candidate differs from expected main SHA; maintenance retained');
  });
});
