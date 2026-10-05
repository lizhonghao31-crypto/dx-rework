import { readFileSync, writeFileSync } from 'node:fs';
const [input, output] = process.argv.slice(2);
const template = readFileSync(input, 'utf8');
if (!template.includes('http://127.0.0.1:3201') || !template.includes('/opt/dx-rework/frontend/current')) throw Error('Unsupported dedicated vhost');
// Preserve the Acceptance prefix while rejecting all new production requests.
const content = template.replace(/\bserver\s*\{/g, '$&\n    if ($uri !~ "^/acceptance/") { return 503; }');
if (content === template) throw Error('No dedicated server block');
writeFileSync(output, content, { mode: 0o640 });
