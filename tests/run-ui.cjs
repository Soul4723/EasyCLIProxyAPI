// Runs the browser UI tests (tests/*-ui.cjs) one after another. Each script starts its own
// Vite server on a free port, so no dev server needs to be running.
//
//   node tests/run-ui.cjs                 run every UI test
//   node tests/run-ui.cjs usage theme     run tests whose file name contains any argument
//
// PLAYWRIGHT_CHANNEL selects an installed browser (for example `msedge` or `chrome`);
// bundled Chromium is used otherwise (Edge on Windows). PLAYWRIGHT_MODULE points at an
// existing Playwright installation.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const filters = process.argv.slice(2);
const scripts = fs.readdirSync(__dirname)
  .filter(name => name.endsWith('-ui.cjs') && name !== 'run-ui.cjs')
  .filter(name => !filters.length || filters.some(filter => name.includes(filter)))
  .sort();
if (!scripts.length) {
  console.error('No UI tests match', filters.join(' '));
  process.exit(1);
}

const failed = [];
for (const name of scripts) {
  console.log(`\n=== ${name}`);
  const result = spawnSync(process.execPath, [path.join(__dirname, name)], { stdio: 'inherit' });
  if (result.status !== 0) failed.push(name);
}
console.log(`\n${scripts.length - failed.length}/${scripts.length} UI tests passed`);
if (failed.length) {
  console.error(`Failed: ${failed.join(', ')}`);
  process.exit(1);
}
