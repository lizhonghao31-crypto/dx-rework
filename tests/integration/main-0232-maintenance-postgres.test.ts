import pg from 'pg';
import {describe,expect,it} from 'vitest';
import {testExecutionConfig} from '../../scripts/test-execution-config.mjs';
import {claimMainMaintenancePublic} from '../../scripts/test-resource-contract.mjs';
import {runMain0232Maintenance} from '../fixtures/main-0232-maintenance.mjs';

describe('original 0231 to 0232 controlled maintenance on a dedicated real database',()=>{
 it('proves read-only admission, complete rollback, one migration and same-candidate recovery',async()=>{
  const databaseUrl=process.env.MAIN_0232_TEST_DATABASE_URL;
  const adminDatabaseUrl=process.env.MAIN_0232_TEST_ADMIN_DATABASE_URL;
  const expectedPostgresMajor=process.env.MAIN_0232_EXPECTED_PG_MAJOR;
  if(!databaseUrl||!adminDatabaseUrl||!['13','16'].includes(expectedPostgresMajor??'')){
   throw Error('MAIN_0232_TEST_DATABASE_URL, MAIN_0232_TEST_ADMIN_DATABASE_URL and MAIN_0232_EXPECTED_PG_MAJOR=13|16 are required; no default database fallback');
  }
  const pool=new pg.Pool({connectionString:databaseUrl,max:1,connectionTimeoutMillis:5000});
  try{await claimMainMaintenancePublic(pool,process.env);}finally{await pool.end();}
  const receipt=await runMain0232Maintenance({databaseUrl,adminDatabaseUrl,expectedPostgresMajor});
  expect(receipt).toMatchObject({expectedPostgresMajor:Number(expectedPostgresMajor),preservedMigrationReceipts:231,migration:{version:'0232_pmc_readonly_role',applied:1},repeatedApplied:0});
  expect(receipt.preservedEmployeeAssignments).toBeGreaterThan(0);
  process.stdout.write('MAIN_0232_MAINTENANCE_PASSED '+JSON.stringify(receipt)+'\n');
 },testExecutionConfig.correctnessTimeoutMs);
});
