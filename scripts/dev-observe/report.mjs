import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function writeReport(out, rows, seconds, mode) {
  const baseline = mode === 'remote' ? [4, 8] : [2, 6];
  const results = rows.map(row => ({ ...row, mutationsPerMinute: row.mutations * 60 / seconds,
    baselineCallsPerMinute: baseline,
    aboveIdleBaseline: row.callsPerMinute > baseline[1],
    settingsMutationRegression: row.route.startsWith('/settings/') && row.mutations > 0 }));
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(results, null, 2) + '\n');
  const table = [`# ${mode} real-app idle pass`, '', `Idle window: ${seconds} s. Reference: ${baseline.join('–')} IPC calls/min/page; Settings DOM mutations: 0.`, '',
    '| Page | Calls/min | DOM records/min | Documents | Top commands |', '|---|---:|---:|---:|---|',
    ...results.map(r => `| ${r.route} | ${r.callsPerMinute.toFixed(2)} | ${r.mutationsPerMinute.toFixed(2)} | ${r.documents} | ${Object.entries(r.commands).slice(0, 4).map(([k, v]) => `${k}: ${v}`).join('; ')} |`), '',
    'Rates exclude navigation/settling and dev_report calls. DOM counts are lower bounds when documents reload. Screenshots require visual review; mutation records do not measure rendered frames.', '',
    ...results.filter(r => r.aboveIdleBaseline || r.settingsMutationRegression || r.documents !== 1 || r.actualRoutes.some(route => route !== `#${r.route}`)).map(r => `- Inspect ${r.route}: above baseline=${r.aboveIdleBaseline}, Settings mutations=${r.settingsMutationRegression}, sampled documents=${r.documents}, actual routes=${r.actualRoutes.join(', ')}.`)];
  const trace = path.join(out, 'connect.trace');
  if (fs.existsSync(trace)) {
    const attempts = fs.readFileSync(trace, 'utf8').split('\n').flatMap(line => {
      const m = line.match(/^(\d+)\s+(\d+\.\d+)\s+connect\(/);
      return m ? [{ thread: Number(m[1]), atUnixSeconds: Number(m[2]), syscall: line.slice(m[0].length - 8) }] : [];
    });
    fs.writeFileSync(path.join(out, 'connect.json'), JSON.stringify(attempts, null, 2) + '\n');
    table.push('', `${attempts.length} connect syscalls recorded in connect.json (all destinations, not HTTP request counts). Filter by destination and thread before assessing retry intervals; frontend IPC does not count native collector HTTP.`);
  }
  fs.writeFileSync(path.join(out, 'summary.md'), table.join('\n') + '\n');
}

// Rebuild the report from captured summaries and socket trace, without a GUI.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = path.resolve(process.argv[2] || '.');
  const run = JSON.parse(fs.readFileSync(path.join(out, 'run.json'), 'utf8'));
  const rows = JSON.parse(fs.readFileSync(path.join(out, 'summary.json'), 'utf8'));
  writeReport(out, rows, run.seconds, run.mode);
}
