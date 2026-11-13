// Runs every test/*.test.mjs with Node's built-in test runner.
// (Listing the files here works the same on every Node version and every shell.)
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const files = readdirSync(join(root, 'test')).filter((f) => f.endsWith('.test.mjs')).sort().map((f) => join('test', f));
const r = spawnSync(process.execPath, ['--test', ...files], { cwd: root, stdio: 'inherit' });
process.exit(r.status ?? 1);
