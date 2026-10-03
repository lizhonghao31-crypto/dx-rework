import pg from "pg";
import { maintainAcceptanceWorkerPeople, workerPeopleConfiguration } from "./worker-people-maintenance.js";
import { assertAcceptanceDatabaseName } from "./database-guard.js";

const config = workerPeopleConfiguration(process.env, process.argv.slice(2));
const database = new pg.Pool({ connectionString: config.connectionString, max: 2,
  application_name: "dx-acceptance-worker-people-check",
  ...(config.apply ? {} : { options: "-c default_transaction_read_only=on" }),
});
try {
  const connected = await database.query<{ name: string }>("SELECT current_database() AS name");
  assertAcceptanceDatabaseName(connected.rows[0]?.name ?? "", "connected");
  const report = await maintainAcceptanceWorkerPeople(database, config.corpId, config.apply, config);
  console.log(JSON.stringify(report, null, 2));
  if (!report.ready) process.exitCode = 2;
} finally {
  await database.end();
}
