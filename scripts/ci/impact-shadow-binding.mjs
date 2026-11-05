import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {hash,policyRulesHash,validPath} from './impact-shadow.mjs';

export const SHADOW_POLICY_PATH='scripts/ci/impact-shadow-policy.json';
const EVIDENCE_PATH='docs/engineering/construction-evidence.json';
const sha=value=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value);
const git=(root,...args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe'],maxBuffer:32*1024*1024});
const names=raw=>raw.split('\0').filter(Boolean);
function entries(root,ref){
 const index=ref===':index',raw=git(root,...(index?['ls-files','--stage','-z']:['ls-tree','-r','-z','--full-tree',ref]));
 return names(raw).map(line=>{
  const match=line.match(index?/^([0-7]{6}) ([a-f0-9]{40}) 0\t(.+)$/:/^([0-7]{6}) blob ([a-f0-9]{40})\t(.+)$/);
  if(!match||!['100644','100755'].includes(match[1])||!validPath(match[3]))throw Error('unsupported tracked input or unresolved index');
  return [match[3],match[1],match[2]];
 });
}
export function shadowInputsHash(root,policy,ref='HEAD'){
 if(!validPath(policy?.root)||[SHADOW_POLICY_PATH,EVIDENCE_PATH].includes(policy.root))throw Error('invalid pilot root');
 const all=entries(root,ref);if(!all.some(([p])=>p===policy.root))throw Error('pilot root is not a regular tracked input');
 const excluded=new Set([policy.root,SHADOW_POLICY_PATH,EVIDENCE_PATH]);
 const inputs=all.filter(([p])=>!excluded.has(p)).sort(([a],[b])=>a<b?-1:a>b?1:0);
 return hash({version:1,policyRulesHash:policyRulesHash(policy),inputs});
}
function ancestor(root,base,head){try{git(root,'merge-base','--is-ancestor',base,head);return true;}catch{return false;}}
export function verifyShadowBinding(root,identity,policy){
 const result={version:1,base:identity?.base,head:identity?.head,anchor:policy?.binding?.anchor,policyRulesHash:policyRulesHash(policy)};
 const mismatch=reason=>({...result,status:'mismatch',reason});
 try{
  const b=policy?.binding;
  if(b?.version!==1||!sha(b.anchor)||!sha(identity?.base)||!sha(identity?.head)||!/^[a-f0-9]{64}$/.test(b.inputsHash??''))return mismatch('invalid-reviewed-binding');
  if(git(root,'rev-parse','HEAD').trim()!==identity.head)return mismatch('head-checkout-differs');
  if(!ancestor(root,b.anchor,identity.base)||!ancestor(root,b.anchor,identity.head))return mismatch('unreviewed-ancestry');
  if(names(git(root,'diff','HEAD','--name-only','-z')).length||names(git(root,'ls-files','--others','--exclude-standard','-z')).length)return mismatch('uncommitted-inputs');
  result.baseInputsHash=shadowInputsHash(root,policy,identity.base);result.headInputsHash=shadowInputsHash(root,policy,identity.head);
  if(result.baseInputsHash!==b.inputsHash||result.headInputsHash!==b.inputsHash)return mismatch('reviewed-input-drift');
  return {...result,status:'matched'};
 }catch{return mismatch('unreadable-reviewed-inputs');}
}
export function stampShadowPolicy(root,policy,anchor){
 if(!sha(anchor)||!ancestor(root,anchor,'HEAD'))throw Error('review anchor is not a checkout ancestor');
 const allowed=new Set([SHADOW_POLICY_PATH,EVIDENCE_PATH]);
 if(names(git(root,'diff','--name-only','-z')).some(p=>!allowed.has(p))||names(git(root,'ls-files','--others','--exclude-standard','-z')).some(p=>!allowed.has(p)))throw Error('stage reviewed inputs before binding');
 const next={...policy,binding:{version:1,anchor,inputsHash:''}};next.binding.inputsHash=shadowInputsHash(root,next,':index');return next;
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
 const [mode,anchor]=process.argv.slice(2);if(mode!=='stamp')throw Error('Expected stamp <reviewed ancestor SHA>; stage reviewed source inputs first');
 const root=process.cwd(),file=resolve(root,SHADOW_POLICY_PATH),policy=JSON.parse(readFileSync(file,'utf8')),next=stampShadowPolicy(root,policy,anchor);
 writeFileSync(file,JSON.stringify(next,null,2)+'\n');console.log(JSON.stringify({anchor:next.binding.anchor,inputsHash:next.binding.inputsHash,policyRulesHash:policyRulesHash(next),boundary:'Reviewed Git input equality and ancestry, not authentication of the reviewer.'}));
}
