import { writeFile } from "node:fs/promises";
import { commentBody } from "./lib.mjs";

const [prNumber, headSha, runId, state, url = "", output] = process.argv.slice(2);
if (!output) throw new Error("usage: status.mjs <pr> <head> <run-id> <state> <url-or-empty> <output>");
const body = commentBody({ prNumber, headSha, runId, state, url: url || undefined });
await writeFile(output, body);
process.stdout.write(body);
