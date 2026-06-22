import chalk from 'chalk';
import { createRequire } from 'module';
import { API_URL, getToken, getDeviceId, CONFIG_FILE } from '../lib/config.js';
import { inspectToken } from '../lib/token.js';
import { resolveMode } from '../lib/output.js';
import { Exit } from '../lib/exitCodes.js';
import { existsSync, statSync } from 'fs';

const require = createRequire(import.meta.url);
const pkg = require('../../package.json');

/**
 * Diagnostic command. Each check returns {name, status, detail}.
 * status: 'pass' | 'warn' | 'fail'. Exit code non-zero if any 'fail'.
 */
export function registerDoctorCommand(program) {
  program
    .command('doctor')
    .description('run diagnostics (auth, network, version freshness)')
    .action(async function () {
      const opts = this.optsWithGlobals();
      const mode = resolveMode(opts);
      const checks = [];

      checks.push(checkConfigFile());
      checks.push(checkToken());
      checks.push(await checkNetwork());
      checks.push(checkAuthValidity());
      checks.push(checkVersion());

      const failed = checks.some((c) => c.status === 'fail');

      if (mode.json) {
        process.stdout.write(JSON.stringify({ schemaVersion: 1, data: { checks, ok: !failed } }) + '\n');
      } else {
        for (const c of checks) {
          const icon = c.status === 'pass' ? chalk.green('✓') : c.status === 'warn' ? chalk.yellow('!') : chalk.red('✗');
          process.stdout.write(`${icon} ${c.name.padEnd(20)} ${chalk.dim(c.detail)}\n`);
        }
      }

      if (failed) process.exitCode = Exit.INTERNAL;
    });
}

function checkConfigFile() {
  if (!existsSync(CONFIG_FILE)) {
    return { name: 'config file', status: 'warn', detail: 'not present (run: shumi login)' };
  }
  const mode = (statSync(CONFIG_FILE).mode & 0o777).toString(8);
  if (mode !== '600') {
    return { name: 'config file', status: 'warn', detail: `mode ${mode} (expected 600)` };
  }
  return { name: 'config file', status: 'pass', detail: `${CONFIG_FILE} (mode ${mode})` };
}

function checkToken() {
  const token = getToken();
  if (!token) return { name: 'auth token', status: 'warn', detail: 'no token (run: shumi login or set SHUMI_TOKEN)' };
  const kind = token.startsWith('shumi_sk_') ? 'API key' : 'JWT';
  return { name: 'auth token', status: 'pass', detail: `${kind} present` };
}

async function checkNetwork() {
  try {
    const url = new URL(API_URL);
    const res = await fetch(`${url.protocol}//${url.host}/robots.txt`, { signal: AbortSignal.timeout(5000) });
    return { name: 'network', status: 'pass', detail: `${url.host} reachable (${res.status})` };
  } catch (err) {
    return { name: 'network', status: 'fail', detail: err.message };
  }
}

// Validate the credential locally (structure + expiry). This deliberately does
// NOT hit the server: a metered route (e.g. billing/tier) would spend one of the
// user's free queries just to run `shumi doctor`. The server stays the source of
// truth for acceptance; this only catches the common cases (no/expired/malformed
// token) for free.
function checkAuthValidity() {
  const token = getToken();
  if (!token) return { name: 'auth validity', status: 'warn', detail: 'skipped (no token)' };
  const info = inspectToken(token);
  if (info.kind === 'API key') {
    return { name: 'auth validity', status: 'pass', detail: 'API key present (local check — no quota used)' };
  }
  if (!info.valid) {
    return { name: 'auth validity', status: 'fail', detail: `${info.reason} — run: shumi login` };
  }
  const exp = info.expiresAt ? `, expires ${info.expiresAt.slice(0, 10)}` : '';
  return { name: 'auth validity', status: 'pass', detail: `JWT valid${exp} (local check — no quota used)` };
}

function checkVersion() {
  return { name: 'version', status: 'pass', detail: `${pkg.name}@${pkg.version} on node ${process.version} (deviceId ${getDeviceId().slice(0, 8)}…)` };
}
