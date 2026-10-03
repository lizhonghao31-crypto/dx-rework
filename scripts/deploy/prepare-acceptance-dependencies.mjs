import fs from 'node:fs';
import path from 'node:path';
const root=process.cwd();
const modules=path.join(root,'node_modules');
if(fs.lstatSync(modules).isSymbolicLink()) throw Error('A shared node_modules symlink is forbidden');
const scope=path.join(modules,'@dx-rework');
if(fs.existsSync(scope)&&fs.lstatSync(scope).isSymbolicLink())throw Error('A shared workspace scope symlink is forbidden');
for(const name of ['contracts','config','domain','ui','api','web']) {
  const target=path.join(root,['api','web'].includes(name)?'apps':'packages',name);
  const link=path.join(modules,'@dx-rework',name);
  fs.mkdirSync(path.dirname(link),{recursive:true});
  fs.rmSync(link,{recursive:true,force:true});
  fs.symlinkSync(path.relative(path.dirname(link),target),link,'dir');
  if(fs.realpathSync(link)!==target) throw Error('Workspace dependency escaped candidate');
}
// Copied packaged dependencies may contain dereferenced .bin files: recreate them.
const bin=path.join(modules,'.bin');
fs.rmSync(bin,{recursive:true,force:true});fs.mkdirSync(bin);
const dirs=[];
for(const item of fs.readdirSync(modules,{withFileTypes:true})) {
  if(item.name==='.bin'||!item.isDirectory())continue;
  if(item.name.startsWith('@')) {
    for(const sub of fs.readdirSync(path.join(modules,item.name),{withFileTypes:true})) if(sub.isDirectory()||sub.isSymbolicLink()) dirs.push(path.join(modules,item.name,sub.name));
  } else dirs.push(path.join(modules,item.name));
}
for(const dir of dirs) {
  const file=path.join(dir,'package.json');if(!fs.existsSync(file))continue;
  const pkg=JSON.parse(fs.readFileSync(file,'utf8'));
  const bins=typeof pkg.bin==='string'?{[pkg.name.split('/').at(-1)]:pkg.bin}:pkg.bin??{};
  for(const [name,rel] of Object.entries(bins)) {
    if(!/^[A-Za-z0-9_.-]+$/.test(name)||name==='.'||name==='..')throw Error('Invalid dependency executable name');
    const target=path.resolve(dir,rel);if(!fs.existsSync(target))continue;
    if(!fs.realpathSync(target).startsWith(root+path.sep))throw Error('Dependency executable escaped candidate');
    const link=path.join(bin,name);fs.rmSync(link,{force:true});fs.symlinkSync(path.relative(bin,target),link);
  }
}
