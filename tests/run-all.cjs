// Full local suite. UI browser selection uses PLAYWRIGHT_MODULE/PLAYWRIGHT_CHANNEL.
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const stages = [
  ['Typecheck', 'bun', ['run', 'check']],
  ['Build', 'bun', ['run', 'build']],
  ['Bun', 'bun', ['test']],
  ['Rust', 'cargo', ['test', '--manifest-path', 'src-tauri/Cargo.toml', '--bin', 'cpa-gui']],
  ['UI', process.execPath, [path.join(__dirname, 'run-ui.cjs')]],
];
const failed = [];
for (const [name, command, args] of stages) {
  console.log(`\n=== ${name}`);
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.error) console.error(result.error);
  if (result.status !== 0) failed.push(name);
}
console.log(`\n${stages.length - failed.length}/${stages.length} suite stages passed`);
if (failed.length) {
  console.error(`Failed stages: ${failed.join(', ')}`);
  process.exitCode = 1;
}
