import { createRequire } from 'module';
import { resolveMode } from '../lib/output.js';

const require = createRequire(import.meta.url);
const pkg = require('../../package.json');

/**
 * Structured `shumi version` — distinct from Commander's built-in `--version`.
 * Returns build/env info that AI agents can use for compatibility checks.
 */
export function registerVersionCommand(program) {
  program
    .command('version')
    .description('print version info (with --json: structured)')
    .action(async function () {
      const opts = this.optsWithGlobals();
      const mode = resolveMode(opts);
      const info = {
        name: pkg.name,
        version: pkg.version,
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        installMethod: detectInstallMethod(),
      };
      if (mode.json) {
        process.stdout.write(JSON.stringify({ schemaVersion: 1, data: info }) + '\n');
      } else {
        for (const [k, v] of Object.entries(info)) process.stdout.write(`${k.padEnd(15)} ${v}\n`);
      }
    });
}

function detectInstallMethod() {
  const exe = process.argv[1] || '';
  if (exe.includes('/.npm/')) return 'npm-cache';
  if (exe.includes('/npm/')) return 'npm-global';
  if (exe.includes('/.yarn/')) return 'yarn';
  if (exe.includes('/.pnpm/')) return 'pnpm';
  if (exe.includes('/Homebrew/') || exe.includes('/homebrew/')) return 'homebrew';
  if (exe.includes('npm-link') || exe.includes('/lib/node_modules/')) return 'npm-global';
  return 'unknown';
}
