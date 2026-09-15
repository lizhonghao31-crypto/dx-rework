import pg from "pg";
import { MemberModuleBindingService } from "../apps/api/dist/access/member-module-binding-service.js";

const args = process.argv.slice(2);
const value = (flag) => { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1]; };
const apply = args.includes("--apply");
if (apply && !args.includes("--verified-identities")) throw new Error("Apply requires --verified-identities after reviewing the dry-run and actual account identities");
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for the explicitly selected target environment");
const actor = value("--root-user-id");
const bindings = { li_zhonghao: value("--li-zhonghao"), wu_yunfeng: value("--wu-yunfeng"), li_junyue: value("--li-junyue") };
if (!actor || Object.values(bindings).some(id => !id)) throw new Error("Required: --root-user-id UUID --li-zhonghao UUID --wu-yunfeng UUID --li-junyue UUID; default is dry-run");
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
try { process.stdout.write(`${JSON.stringify(await new MemberModuleBindingService(pool).run(actor, bindings, apply), null, 2)}\n`); }
finally { await pool.end(); }
