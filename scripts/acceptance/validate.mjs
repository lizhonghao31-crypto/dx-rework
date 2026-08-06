import fs from "node:fs";
const file=process.argv[2]; if(!file) throw new Error("usage: validate.mjs MATRIX.json");
const data=JSON.parse(fs.readFileSync(file,"utf8")); const items=data.items;
if(!Array.isArray(items)||items.length!==22) throw new Error("matrix must contain exactly 22 items");
const allowed=new Set(["not_run","passed","failed","blocked"]), seen=new Set();
const required=["requirement","environment","gitSha","schemaVersion","testDataIds","roles","steps","expected","actual","evidenceRefs","executor","reviewer","executedAt","result","defectLinks"];
for(let i=0;i<22;i++){const x=items[i], id=`UAT-${String(i+1).padStart(2,"0")}`; if(x.id!==id)throw new Error(`expected ${id} in order`); if(seen.has(x.id))throw new Error(`duplicate ${x.id}`);seen.add(x.id); for(const k of required)if(!(k in x)||x[k]===null||x[k]===""||(Array.isArray(x[k])&&!["evidenceRefs","defectLinks"].includes(k)&&x[k].length===0))throw new Error(`${id} empty ${k}`);if(!allowed.has(x.result))throw new Error(`${id} invalid result`);if(x.result==="passed"&&(!x.evidenceRefs.length||!x.executor||!x.reviewer||x.executor===x.reviewer||[x.executor,x.reviewer].includes("TBD")))throw new Error(`${id} passed requires independent executor/reviewer and evidence`)}
console.log(`validated ${items.length} PR-17 acceptance items; template results are evidence-safe`);
