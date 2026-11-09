import {randomUUID} from "node:crypto";
import {spawnSync} from "node:child_process";
import {setTimeout as delay} from "node:timers/promises";
import pg from "pg";
import {assertTestDatabaseTarget} from "../test-database-safety.mjs";

if(process.env.NODE_ENV!=="test")throw new Error("Journey PG13 regression requires NODE_ENV=test");
const container=`dx-journey-pg13-${randomUUID().replaceAll("-","").slice(0,12)}`;
const password=randomUUID(),database="dx_journey_ci",user="dx_journey_test";
const clean=value=>String(value??"").replaceAll(password,"[TEST password]");
const command=(args)=>{
 const result=spawnSync("docker",args,{encoding:"utf8",timeout:args[0]==="run"?120000:60000});
 if(result.error||result.status!==0)throw new Error(`Isolated PG13 Docker operation failed: ${args[0]} ${clean(result.stderr)}`);
 return result.stdout.trim();
};
let started=false,admin;
try{
 command(["run","--rm","-d","--name",container,"--label","dx-rework.test=journey-pg13-v1","-e",`POSTGRES_PASSWORD=${password}`,"-p","127.0.0.1::5432","postgres:13.23"]);started=true;
 let ready=false;
 for(let attempt=0;attempt<60;attempt++){
  // The entrypoint's initialization server accepts Unix sockets before final TCP startup.
  if(spawnSync("docker",["exec",container,"pg_isready","-h","127.0.0.1","-U","postgres","-d","postgres"],{stdio:"ignore",timeout:5000}).status===0){ready=true;break;}
  await delay(500);
 }
 if(!ready)throw new Error("Isolated PG13 did not become ready");
 const port=Number(JSON.parse(command(["inspect",container]))[0].NetworkSettings.Ports["5432/tcp"][0].HostPort);
 if(!Number.isInteger(port)||port<1||port>65535)throw new Error("Isolated PG13 port is invalid");
 const url=(role,db)=>`postgresql://${role}:${password}@127.0.0.1:${port}/${db}`;
 admin=new pg.Client({connectionString:url("postgres","postgres"),connectionTimeoutMillis:3000});await admin.connect();
 const version=Number((await admin.query("SHOW server_version_num")).rows[0].server_version_num);
 if(version<130000||version>=140000)throw new Error("Journey compatibility regression must actually run PostgreSQL 13");
 await admin.query(`CREATE ROLE ${user} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
 await admin.query(`CREATE DATABASE ${database} OWNER ${user}`);
 await admin.query(`COMMENT ON DATABASE ${database} IS 'dx-rework-isolated-test-v1'`);
 const testUrl=url(user,database);await assertTestDatabaseTarget(testUrl);
 const result=spawnSync(process.execPath,["node_modules/vitest/vitest.mjs","run","tests/integration/digital-journey-postgres.test.ts","--maxWorkers=2"],{
  encoding:"utf8",timeout:300000,maxBuffer:8*1024*1024,
  env:{...process.env,NODE_ENV:"test",DX_REWORK_TEST_SUITE_KIND:"postgres",DATABASE_URL:"",TEST_DATABASE_URL:testUrl,NO_COLOR:"1",FORCE_COLOR:"0"},
 });
 const output=clean(`${result.stdout??""}${result.stderr??""}`);process.stdout.write(output);
 if(result.error||result.status!==0)throw new Error("Journey PG13 regression suite failed");
 if(!/Tests\s+[1-9][0-9]* passed/.test(output))throw new Error("Journey PG13 suite executed no passing tests");
 process.stdout.write(`${JSON.stringify({status:"passed",postgresVersion:version,databaseRole:"non-superuser",suite:"digital-journey-postgres",coverage:"startup backfill cursor registration, native queue consumption and fact generation; empty logs, first five, twenty-row cursor pages through final page, Root HTTP details, scoped permissions and cursor binding"})}\n`);
}catch(error){process.stderr.write(`JOURNEY_PG13_REGRESSION_FAILED: ${clean(error.message)}\n`);process.exitCode=1;}
finally{
 if(admin)await admin.end().catch(()=>{});
 if(started)spawnSync("docker",["rm","-f",container],{stdio:"ignore",timeout:15000});
}
