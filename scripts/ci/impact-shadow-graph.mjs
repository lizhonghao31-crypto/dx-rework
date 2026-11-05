import {readFileSync,existsSync} from 'node:fs';
import {resolve,relative,dirname} from 'node:path';
import {execFileSync} from 'node:child_process';
import {hash,proposeShadow,parseShadowChanges} from './impact-shadow.mjs';
const portable=p=>p.replaceAll('\\','/');
export function loadShadowPolicy(){return JSON.parse(readFileSync(new URL('./impact-shadow-policy.json',import.meta.url),'utf8'));}
export async function auditShadowGraph(root,policy){
 // Lazy: cheap pre-install node:test checks must not acquire new dependencies.
 const ts=await import('typescript');
 const files=execFileSync('git',['-C',root,'ls-files','--cached','--others','--exclude-standard','-z'],{encoding:'utf8'}).split('\0').filter(Boolean).sort(),tracked=new Set(files),sourceHashes={},edges=new Set(),conservative=new Set(),unsupported=[],source=new Map();
 const add=(from,to)=>edges.add(JSON.stringify([from,to]));
 const workspaces=JSON.parse(readFileSync(resolve(root,'package.json'),'utf8')).workspaces??[];
 const packages=new Map(workspaces.filter(p=>typeof p==='string'&&existsSync(resolve(root,p,'package.json'))).map(p=>{const json=JSON.parse(readFileSync(resolve(root,p,'package.json'),'utf8'));return[json.name,{path:p,json}];}));
 const exportPath=x=>typeof x==='string'?x:x&&typeof x==='object'?exportPath(x.types??x.import??x.default):undefined;
 const lookup=(from,spec)=>{
  const candidates=[];
  if(spec.startsWith('.'))candidates.push(portable(relative(root,resolve(root,dirname(from),spec))));
  else if(/^(apps|packages|tests|scripts|docs)\//.test(spec))candidates.push(spec);
  else if(spec.startsWith('@dx-rework/')){
   const parts=spec.split('/'),pkg=packages.get(parts.slice(0,2).join('/')),sub=parts.length===2?'.':'./'+parts.slice(2).join('/');
   if(pkg){const target=exportPath(typeof pkg.json.exports==='string'?pkg.json.exports:pkg.json.exports?.[sub]??(sub==='.'?pkg.json.types??pkg.json.main:undefined));if(target)candidates.push(portable(relative(root,resolve(root,pkg.path,target))).replace('/dist/','/src/').replace(/\.d\.ts$/,'.ts'));}
  }
  for(const p of candidates)for(const q of [p,p.replace(/\.js$/,'.ts'),p.replace(/\.js$/,'.tsx'),p+'/index.ts',p+'/index.tsx'])if(tracked.has(q)&&existsSync(resolve(root,q)))return q;
 };
 for(const file of files.filter(p=>/^(apps|packages|tests)\//.test(p)&&/\.(?:ts|tsx|js|jsx|mjs)$/.test(p)&&!p.includes('/dist/'))){
  const body=readFileSync(resolve(root,file),'utf8');sourceHashes[file]=hash(body);
  const ast=ts.createSourceFile(file,body,ts.ScriptTarget.Latest,true,/\.tsx$/.test(file)?ts.ScriptKind.TSX:/\.jsx$/.test(file)?ts.ScriptKind.JSX:ts.ScriptKind.TS);source.set(file,ast);
  if(ast.parseDiagnostics.length)unsupported.push(file+':parse-error');
  const visit=node=>{
   if(ts.isStringLiteralLike(node)){
    const to=lookup(file,node.text);if(to)add(file,to);
    if(['node:fs','node:fs/promises','node:child_process','fs','fs/promises','child_process'].includes(node.text))conservative.add(file);
   }
   if(ts.isCallExpression(node)&&(node.expression.kind===ts.SyntaxKind.ImportKeyword||ts.isIdentifier(node.expression)&&['require','eval'].includes(node.expression.text))&&!ts.isStringLiteralLike(node.arguments[0]??{}))conservative.add(file);
   if(file===policy.root&&ts.isCallExpression(node)&&(node.expression.kind===ts.SyntaxKind.ImportKeyword||ts.isIdentifier(node.expression)&&['require','eval'].includes(node.expression.text)))unsupported.push('pilot-runtime-loader');
   if(file===policy.root&&ts.isIdentifier(node)&&['process','global','globalThis'].includes(node.text))unsupported.push('pilot-runtime-global');
   ts.forEachChild(node,visit);
  };visit(ast);
 }
 for(const file of Object.keys(policy.pinnedSources??{}))if(existsSync(resolve(root,file)))sourceHashes[file]=hash(readFileSync(resolve(root,file)));
 const rootAst=source.get(policy.root);if(!rootAst)unsupported.push('pilot-root-unavailable');
 const rootImports=rootAst?[...new Set(rootAst.statements.filter(n=>(ts.isImportDeclaration(n)||ts.isExportDeclaration(n))&&n.moduleSpecifier).map(n=>n.moduleSpecifier.text))].sort():[];
 function value(node){
  if(ts.isStringLiteralLike(node))return node.text;if(ts.isNumericLiteral(node))return Number(node.text);
  if(node.kind===ts.SyntaxKind.TrueKeyword)return true;if(node.kind===ts.SyntaxKind.FalseKeyword)return false;if(node.kind===ts.SyntaxKind.NullKeyword)return null;
  if(ts.isPrefixUnaryExpression(node)&&node.operator===ts.SyntaxKind.MinusToken)return -value(node.operand);
  if(ts.isArrayLiteralExpression(node))return node.elements.map(value);
  if(ts.isObjectLiteralExpression(node))return Object.fromEntries(node.properties.map(p=>{if(!ts.isPropertyAssignment(p))throw Error('unsupported parameter object');return[p.name.text,value(p.initializer)];}));
  throw Error('unsupported parameter input');
 }
 const declarations=[];
 for(const file of new Set(policy.expectedCases.map(c=>c.file))){
  const ast=source.get(file);if(!ast)throw Error('Expected case module missing: '+file);
  const visit=(node,ancestors)=>{
   if(ts.isCallExpression(node)){
    let name,rows;
    if(ts.isIdentifier(node.expression))name=node.expression.text;
    else if(ts.isCallExpression(node.expression)&&ts.isPropertyAccessExpression(node.expression.expression)&&node.expression.expression.name.text==='each'&&ts.isIdentifier(node.expression.expression.expression)){name=node.expression.expression.expression.text;rows=value(node.expression.arguments[0]);if(!Array.isArray(rows)||!rows.length)throw Error('Empty parameter family');}
    if(['describe','it','test'].includes(name)){
     const title=node.arguments[0],body=node.arguments[1];if(!title||!ts.isStringLiteralLike(title)||!body||!ts.isArrowFunction(body)&&!ts.isFunctionExpression(body))throw Error('Unsupported case declaration');
     if(name==='describe'){if(rows)throw Error('Unsupported parameterized describe');visit(body,[...ancestors,title.text]);return;}
     for(const row of rows??[undefined]){
      let rendered=title.text,rowKey=null,parameterHash=null;
      if(row!==undefined){rowKey=typeof row==='string'?row:row.caseId;if(typeof rowKey!=='string'||!rowKey)throw Error('Explicit parameter identity required');parameterHash=hash(row);rendered=typeof row==='string'?rendered.replace('%s',row):rendered.replace('$caseId',row.caseId);if(/%[sdifjo#]|\$\w/.test(rendered))throw Error('Ambiguous parameter display');}
      declarations.push({file,ancestors,title:rendered,rowKey,parameterHash});
     }return;
    }
   }
   ts.forEachChild(node,child=>visit(child,ancestors));
  };visit(ast,[]);
 }
 return{graph:{rootImports,edges:[...edges].map(e=>JSON.parse(e)).sort(),conservativeConsumers:[...conservative].sort(),unsupported},declarations,sourceHashes};
}
export async function createImpactShadow(identity,inputs,{root=process.cwd(),policy=loadShadowPolicy(),changes}={}){
 const changed=changes??parseShadowChanges(execFileSync('git',['-C',root,'diff','--name-status','--no-renames','-z',identity.base,identity.head],{encoding:'utf8'}));
 const toolchain={node:process.versions.node,vitest:JSON.parse(readFileSync(resolve(root,'node_modules/vitest/package.json'))).version,typescript:JSON.parse(readFileSync(resolve(root,'node_modules/typescript/package.json'))).version};
 if(!Array.isArray(changed)||!changed.length||changed.some(c=>c?.status!=='M'||c.path!==policy.root))return proposeShadow({identity,inputs,changes:changed,policy,graph:{},declarations:[],sourceHashes:{},toolchain});
 const audit=await auditShadowGraph(root,policy);
 return proposeShadow({identity,inputs,changes:changed,policy,...audit,toolchain});
}
