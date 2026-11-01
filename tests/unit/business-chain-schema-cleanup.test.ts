import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { ownedPostgresSchema, dropOwnedPostgresSchema } from "../helpers/owned-postgres-schema.js";

const oldRunId=process.env.DX_REWORK_TEST_RUN_ID;
const oldManifest=process.env.DX_REWORK_TEST_RESOURCE_MANIFEST_DIR;
afterEach(()=>{
  if(oldRunId===undefined) delete process.env.DX_REWORK_TEST_RUN_ID; else process.env.DX_REWORK_TEST_RUN_ID=oldRunId;
  if(oldManifest===undefined) delete process.env.DX_REWORK_TEST_RESOURCE_MANIFEST_DIR; else process.env.DX_REWORK_TEST_RESOURCE_MANIFEST_DIR=oldManifest;
});

describe("business-chain isolated schema cleanup",()=>{
  it("rejects an unowned cleanup before opening a database connection", async()=>{
    const connect=vi.fn();
    await expect(dropOwnedPostgresSchema({connect} as unknown as Pool,`root_http_1_${'f'.repeat(32)}`)).rejects.toThrow('not generated');
    expect(connect).not.toHaveBeenCalled();
  });

  it("rolls back a failed owned teardown and releases its serialization lock", async()=>{
    const schema=ownedPostgresSchema('root_http_1'),failure=new Error('TEST failed schema teardown');
    const query=vi.fn().mockResolvedValue({rows:[]}).mockImplementationOnce(async()=>({rows:[]})).mockImplementationOnce(async()=>({rows:[]})).mockRejectedValueOnce(failure);
    const release=vi.fn(),pool={connect:async()=>({query,release})} as unknown as Pool;
    await expect(dropOwnedPostgresSchema(pool,schema)).rejects.toBe(failure);
    expect(query).toHaveBeenLastCalledWith('ROLLBACK');
    expect(release).toHaveBeenCalledOnce();
  });

  it("records only schemas owned by the current run",async()=>{
    const dir=await mkdtemp(join(tmpdir(),"dx-rework-owned-schema-"));
    try{
      process.env.DX_REWORK_TEST_RUN_ID="1234abcd";
      process.env.DX_REWORK_TEST_RESOURCE_MANIFEST_DIR=dir;
      const schema=ownedPostgresSchema("receiving");
      expect(schema).toMatch(/^receiving_1234abcd[0-9a-f]{24}$/);
      const names=await readdir(dir);
      expect(names).toEqual([`${schema}.json`]);
      expect(JSON.parse(await readFile(join(dir,names[0]!),"utf8")))
        .toEqual({kind:"postgres-schema",runId:"1234abcd",schema});
    }finally{await rm(dir,{recursive:true,force:true});}
  });

  it("uses explicit TEST_DATABASE_URL and exact manifest cleanup",async()=>{
    const source=await readFile(new URL("../../scripts/run-business-chain-gate.mjs",import.meta.url),"utf8");
    expect(source).toContain("process.env.TEST_DATABASE_URL?.trim()");
    expect(source).not.toContain("process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL");
    expect(source).not.toContain("FROM pg_namespace");
    expect(source).toContain("DX_REWORK_TEST_RESOURCE_MANIFEST_DIR");
    expect(source).toContain("cleanupOwnedGateSchemas()");
    expect(source).toContain("BUSINESS_CHAIN_GATE_INTERRUPTED");
  });

  it("records the clock database alias without storing credentials or widening schema ownership",async()=>{
    const dir=await mkdtemp(join(tmpdir(),"dx-rework-clock-owned-"));
    try{
      process.env.DX_REWORK_TEST_RUN_ID="1234abcd";
      process.env.DX_REWORK_TEST_RESOURCE_MANIFEST_DIR=dir;
      const schema=ownedPostgresSchema("business_anchors","acceptance-clock");
      expect(JSON.parse(await readFile(join(dir,`${schema}.json`),"utf8")))
        .toEqual({kind:"postgres-schema",runId:"1234abcd",schema,databaseTarget:"acceptance-clock"});
      expect(()=>ownedPostgresSchema("receiving","acceptance-clock")).toThrow("Unsupported");
      expect(()=>ownedPostgresSchema("business_anchors","untrusted" as "acceptance-clock")).toThrow("Unsupported");
      expect(await readdir(dir)).toEqual([`${schema}.json`]);
    }finally{await rm(dir,{recursive:true,force:true});}
  });

  it("keeps the original clock fixture and every child initializer on its explicit isolated database",async()=>{
    const [test,fixture,gate]=await Promise.all([
      readFile(new URL("../integration/development-technical-postgres.test.ts",import.meta.url),"utf8"),
      readFile(new URL("../helpers/business-anchor-fixture.ts",import.meta.url),"utf8"),
      readFile(new URL("../../scripts/run-business-chain-gate.mjs",import.meta.url),"utf8"),
    ]);
    expect(test).toContain("process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL");
    expect(fixture).toContain("DATABASE_URL:'',TEST_DATABASE_URL:url");
    expect(fixture).toContain("ACCEPTANCE_DATABASE_URL:scoped.toString()");
    expect(gate).toContain('resource.databaseTarget !== "acceptance-clock"');
    expect(gate).toContain('!resource.schema.startsWith("business_anchors_")');
    expect(gate).toContain("await assertTestDatabaseTarget(targetUrl)");
  });

  it("registers personnel test schemas without admitting arbitrary schema names", async () => {
    const source = await readFile(new URL("../../scripts/run-business-chain-gate.mjs", import.meta.url), "utf8");
    const expression = source.match(/const ISOLATED_GATE_SCHEMA = \/(.+)\/;/)?.[1];
    expect(expression).toBeDefined();
    const allowed = new RegExp(expression!);
    expect(allowed.test(`acceptance_people_${"1234abcd".repeat(4)}`)).toBe(true);
    expect(allowed.test(`unrelated_${"1234abcd".repeat(4)}`)).toBe(false);
    expect(allowed.test("acceptance_people_public")).toBe(false);
  });

  it("cleans the quotation schema registered by this run without widening cleanup ownership", async () => {
    const dir=await mkdtemp(join(tmpdir(),"dx-rework-quote-cleanup-"));
    try {
      process.env.DX_REWORK_TEST_RUN_ID="1234abcd";
      process.env.DX_REWORK_TEST_RESOURCE_MANIFEST_DIR=dir;
      const schema=ownedPostgresSchema("customer_quote");
      const source=await readFile(new URL("../../scripts/run-business-chain-gate.mjs",import.meta.url),"utf8");
      const allowed=new RegExp(source.match(/const ISOLATED_GATE_SCHEMA = \/(.+)\/;/)![1]!);
      expect(allowed.test(ownedPostgresSchema("business_anchors"))).toBe(true);
      const manifest=JSON.parse(await readFile(join(dir,`${schema}.json`),"utf8"));
      expect(allowed.test(manifest.schema)).toBe(true);
      expect(manifest).toEqual({kind:"postgres-schema",runId:"1234abcd",schema});
      expect(schema.slice(-32).startsWith(manifest.runId)).toBe(true);
      for(const rejected of ["customer_quote_public",`customer_quote_${"1234abcd".repeat(4)};DROP SCHEMA public`,`customer_quote_${"1234abcd".repeat(4)}_extra`,`unrelated_${"1234abcd".repeat(4)}`])expect(allowed.test(rejected)).toBe(false);
      expect(source).toContain('resource.runId !== runId');
      expect(source).toContain('entry.name !== `${resource.schema}.json`');
      expect(source).not.toContain("FROM pg_namespace");
    } finally {await rm(dir,{recursive:true,force:true});}
  });

  it("prevents test entrypoints from inheriting generic DATABASE_URL",async()=>{
    const [a,b,c,d]=await Promise.all([
      readFile(new URL("../../vitest.config.ts",import.meta.url),"utf8"),
      readFile(new URL("../../vitest.business-chain.config.ts",import.meta.url),"utf8"),
      readFile(new URL("../../scripts/migration-integration-check.mjs",import.meta.url),"utf8"),
      readFile(new URL("../../scripts/seed-base-migrations.sh",import.meta.url),"utf8"),
    ]);
    expect(a).toContain('env: { DATABASE_URL: "" }');
    expect(b).toContain('env: { DATABASE_URL: "" }');
    expect(c).toContain("requireTestDatabaseUrl()");
    expect(c).not.toContain("?? process.env.DATABASE_URL");
    expect(d).toContain('TEST_DATABASE_URL:?TEST_DATABASE_URL is required');
    expect(d).toContain('DATABASE_URL="$TEST_DATABASE_URL" node scripts/migrate.mjs');
  });
});
