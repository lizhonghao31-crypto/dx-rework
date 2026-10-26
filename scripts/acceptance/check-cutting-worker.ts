import pg from "pg";
import { cuttingWorkerConfiguration, maintainAcceptanceCuttingWorker } from "./cutting-worker-maintenance.js";

const args = process.argv.slice(2), config = cuttingWorkerConfiguration(process.env, args);
const pool = new pg.Pool({ connectionString: config.connectionString, max: 2, application_name: "dx-acceptance-cutting-worker-fixture" });
try {
  console.log(JSON.stringify(await maintainAcceptanceCuttingWorker(pool, process.env, args), null, 2));
} finally { await pool.end(); }
