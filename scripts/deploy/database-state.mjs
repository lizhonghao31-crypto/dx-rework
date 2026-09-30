#!/usr/bin/env node
import fs from "node:fs";
import pg from "pg";
const { Client } = pg;
const [command, manifestPath] = process.argv.slice(2);
if (!new Set(["verify-prefix", "verify-current", "print-current", "fingerprint"]).has(command)) throw new Error("usage: database-state.mjs verify-prefix|verify-current|print-current|fingerprint [manifest]");
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const client = new Client({ connectionString: process.env.DATABASE_URL }); await client.connect();
try {
  if (command === "fingerprint") {
    const r=await client.query("select inet_server_addr()::text as address, inet_server_port() as port, current_database() as database");
    const v=r.rows[0]; process.stdout.write(JSON.stringify({address:v.address,port:Number(v.port),database:v.database})+"\n");
  } else {
    let rows=[]; try { rows=(await client.query("select version, trim(checksum) as checksum from schema_migrations order by version")).rows; } catch(e) { if(e.code!=="42P01")throw e; }
    if(command==="print-current") { const x=rows.at(-1)??null; process.stdout.write(JSON.stringify({count:rows.length,version:x?.version??null,checksum:x?.checksum??null})+"\n"); }
    else {
      if(!manifestPath)throw new Error("manifest path is required"); const expected=JSON.parse(fs.readFileSync(manifestPath,"utf8")).migrations;
      if(!Array.isArray(expected))throw new Error("invalid migration manifest"); if(rows.length>expected.length)throw new Error("database history exceeds target manifest");
      for(let i=0;i<rows.length;i++)if(rows[i].version!==expected[i]?.version||rows[i].checksum!==expected[i]?.checksum)throw new Error(`migration history diverged at ${i+1}`);
      if(command==="verify-current"&&rows.length!==expected.length)throw new Error(`database is not current: ${rows.length}/${expected.length}`);
      const x=rows.at(-1)??null; process.stdout.write(JSON.stringify({status:"pass",mode:command,count:rows.length,version:x?.version??null,checksum:x?.checksum??null})+"\n");
    }
  }
} finally { await client.end(); }
