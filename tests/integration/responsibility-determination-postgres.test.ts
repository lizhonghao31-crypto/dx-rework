import { describe,it } from "vitest";
describe.skipIf(!process.env.TEST_DATABASE_URL)("responsibility PostgreSQL guards",()=>{it.todo("covers approved processes, report snapshots, concurrency, idempotency, authorization and immutable history")});
