// Regression suite for the IC+ calculator. Plain node, no runner, no dependencies —
// `node services/icplus/__tests__/run.js` from the backend root.
//
// ⚠️ Per §9.4 of the scope: any change to SHARED code (rateTables.js, classify.js,
// calc.js) must be re-run against EVERY processor's cases before shipping, not just the
// processor being worked on. That is what this file is for — one command, everything.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const dir = __dirname;
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.test.js')).sort();

let failed = 0;
for (const f of files) {
  process.stdout.write(`\n──── ${f}\n`);
  try {
    process.stdout.write(execFileSync(process.execPath, [path.join(dir, f)], { encoding: 'utf8' }));
  } catch (e) {
    process.stdout.write(e.stdout || '');
    process.stdout.write(e.stderr || '');
    failed++;
  }
}

console.log(failed ? `\n${failed} suite(s) FAILING` : `\n${files.length} suite(s) green`);
process.exit(failed ? 1 : 0);
