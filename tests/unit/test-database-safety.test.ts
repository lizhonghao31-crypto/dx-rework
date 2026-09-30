import { describe, expect, it } from "vitest";
import { TEST_DATABASE_MARKER, requireTestDatabaseUrl, validateTestDatabaseIdentity } from "../../scripts/test-database-safety.mjs";

const url="postgresql://dx_rework_test:secret@127.0.0.1:5432/dx_rework_ci";
const safe={database:"dx_rework_ci",username:"dx_rework_test",marker:TEST_DATABASE_MARKER,allowConnections:true,isTemplate:false,isSuperuser:false,canCreateDatabase:false,canCreateRole:false,canReplicate:false,canBypassRls:false};

describe("test database safety",()=>{
  it("requires explicit TEST_DATABASE_URL in NODE_ENV=test",()=>{
    expect(requireTestDatabaseUrl({NODE_ENV:"test",TEST_DATABASE_URL:url,DATABASE_URL:"postgresql://production.invalid/prod"} as NodeJS.ProcessEnv)).toBe(url);
    expect(()=>requireTestDatabaseUrl({NODE_ENV:"test",DATABASE_URL:url} as NodeJS.ProcessEnv)).toThrow("explicit TEST_DATABASE_URL is required");
    expect(()=>requireTestDatabaseUrl({NODE_ENV:"production",TEST_DATABASE_URL:url} as NodeJS.ProcessEnv)).toThrow("NODE_ENV=test is required");
  });
  it("accepts only the exact marked database and non-privileged account",()=>{
    expect(()=>validateTestDatabaseIdentity(url,safe)).not.toThrow();
    expect(()=>validateTestDatabaseIdentity(url,{...safe,marker:null})).toThrow("not an approved isolated test database");
    expect(()=>validateTestDatabaseIdentity(url,{...safe,isSuperuser:true})).toThrow("unsafe cluster-level privileges");
    expect(()=>validateTestDatabaseIdentity(url,{...safe,username:"postgres"})).toThrow("does not match TEST_DATABASE_URL");
  });
});
