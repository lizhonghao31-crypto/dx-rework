import { readFileSync, writeFileSync } from 'node:fs';
const [input, output, web, port] = process.argv.slice(2);
if (!['3201', '3203'].includes(port) || !/^\/opt\/dx-rework\/frontend\/releases\/[0-9a-f]{40}$/.test(web)) throw Error('Invalid generation');
const template = readFileSync(input, 'utf8');
if (!template.includes('http://127.0.0.1:3201') || !template.includes('/opt/dx-rework/frontend/current')) throw Error('Unsupported nginx configuration; preserve and inspect before installation');
// Start from the exact installed vhost, preserving Acceptance/TLS/logging rules.
// Each nginx worker pins BOTH its frontend path and API generation at reload.
const content = template.replaceAll('http://127.0.0.1:3201', `http://127.0.0.1:${port}`)
  .replaceAll('/opt/dx-rework/frontend/current', web);
writeFileSync(output, content, { mode: 0o640 });
