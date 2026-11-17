// Run every browser test in this folder, one after another, and fail if any
// fails. Usage: node tests/run.mjs [repository root]
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import fs from 'fs';
import path from 'path';

const dir = path.dirname(fileURLToPath(import.meta.url));
const files = fs.readdirSync(dir)
  .filter((f) => f.endsWith('.mjs') && !['harness.mjs', 'run.mjs'].includes(f))
  .sort();
let failed = 0;
for (const f of files) {
  console.log(`\n=== ${f}`);
  const r = spawnSync(process.execPath, [path.join(dir, f), ...process.argv.slice(2)], { stdio: 'inherit' });
  if (r.status !== 0) failed++;
}
console.log(`\n${files.length - failed} of ${files.length} test files passed`);
process.exit(failed ? 1 : 0);
