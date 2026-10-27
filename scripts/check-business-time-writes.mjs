import {readdir,readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';

// Deliberately small, enforced business occurrence contract. These columns
// have SQL wall defaults for legacy compatibility, so every new API writer
// must supply the occurrence explicitly. Audit columns are not on this list.
export const BUSINESS_OCCURRENCE_COLUMNS=Object.freeze({
 digital_factory_qc:'checked_at',
 digital_bulk_cutting_completions:'completed_at',
 rework_work_reports:'completed_at',
 sourcing_contract_business_ready_facts:'business_ready_at',
 sourcing_contract_return_business_facts:'business_returned_at',
});
export function businessTimeWriteViolations(sql){
 const errors=[];
 for(const match of sql.matchAll(/\bINSERT\s+INTO\s+(\w+)\s*\(([^)]+)\)/gi)){
  const table=match[1].toLowerCase(),column=BUSINESS_OCCURRENCE_COLUMNS[table];
  if(!column)continue;
  const columns=match[2].split(',').map(v=>v.trim().toLowerCase());
  if(!columns.includes(column)){errors.push(`${table}.${column}: implicit SQL default`);continue;}
  // The protected INSERTs contain only parameterized business values. Keep
  // audit writes in their own statement rather than ignoring mixed literals.
  const statement=sql.slice(match.index).split(';',1)[0];
  if(/\b(?:CURRENT_TIMESTAMP|LOCALTIMESTAMP|clock_timestamp\s*\(|statement_timestamp\s*\(|transaction_timestamp\s*\(|now\s*\()/i.test(statement))errors.push(`${table}.${column}: SQL wall clock`);
 }
 return errors;
}
export async function checkBusinessTimeWriters(root=resolve('apps/api/src')){
 const errors=[];
 const walk=async directory=>{for(const entry of await readdir(directory,{withFileTypes:true})){const path=resolve(directory,entry.name);if(entry.isDirectory())await walk(path);else if(entry.name.endsWith('.ts')){
  const source=ts.createSourceFile(path,await readFile(path,'utf8'),ts.ScriptTarget.Latest,true);
  const visit=node=>{
   if(ts.isStringLiteralLike(node)||ts.isNoSubstitutionTemplateLiteral(node)||ts.isTemplateExpression(node)){
    const sql=ts.isTemplateExpression(node)?node.head.text+node.templateSpans.map(s=>` __dynamic__ ${s.literal.text}`).join(''):node.text;
    for(const error of businessTimeWriteViolations(sql)){const {line}=source.getLineAndCharacterOfPosition(node.getStart(source));errors.push(`${path}:${line+1}: ${error}`);}
   }
   ts.forEachChild(node,visit);
  };visit(source);
 }}};await walk(root);return errors;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const errors=await checkBusinessTimeWriters();if(errors.length){process.stderr.write(errors.join('\n')+'\n');process.exitCode=1;}else process.stdout.write('Business occurrence writers: explicit scoped values required; no violations\n');
}
