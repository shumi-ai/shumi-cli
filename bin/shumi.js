#!/usr/bin/env node

import { createRequire } from 'module';
import { program } from 'commander';
import updateNotifier from 'update-notifier';
import { registerCommands } from '../src/index.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json');

// Update notifier — stderr only, suppressed in non-TTY / agent mode / env opt-out
// so it never corrupts piped JSON output.
const isTty = Boolean(process.stdout.isTTY);
const isAgent = process.argv.includes('--agent') || process.env.SHUMI_AGENT === '1';
const optOut = process.env.SHUMI_NO_UPDATE_NOTIFIER === '1';
if (isTty && !isAgent && !optOut) {
  updateNotifier({ pkg, updateCheckInterval: 1000 * 60 * 60 * 24 }).notify({ defer: true });
}

// SIGINT: clean exit so spinners don't leave dangling state.
process.on('SIGINT', () => {
  process.stderr.write('\n');
  process.exit(130);
});

program
  .name('shumi')
  .description('Shumi — crypto trade intelligence from your terminal')
  .version(pkg.version)
  .option('--json', 'emit JSON envelope on stdout (auto-enabled when stdout is not a TTY)')
  .option('--agent', 'machine mode: JSON output, no spinner, no color, no update notifier')
  .option('--no-color', 'disable colored output')
  .option('--fields <list>', 'comma-separated top-level keys to keep (filter response)')
  .option('--top <n>', 'keep first N items if response is an array', (v) => parseInt(v, 10));

registerCommands(program);

program.parseAsync().catch((err) => {
  process.stderr.write(`shumi: ${err?.message || err}\n`);
  process.exit(1);
});
