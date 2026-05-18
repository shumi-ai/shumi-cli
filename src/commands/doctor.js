import chalk from 'chalk';
import { createRequire } from 'module';
import { API_URL, getToken, getDeviceId, CONFIG_FILE } from '../lib/config.js';
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
      checks.push(await checkAuthEndpoint());
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

async function checkAuthEndpoint() {
  const token = getToken();
  if (!token) return { name: 'auth endpoint', status: 'warn', detail: 'skipped (no token)' };
  try {
    const res = await fetch(`${API_URL}/billing/tier`, {
      headers: { 'Authorization': `Bearer ${token}` },
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) return { name: 'auth endpoint', status: 'pass', detail: `authenticated (${res.status})` };
    if (res.status === 401 || res.status === 403) return { name: 'auth endpoint', status: 'fail', detail: `auth rejected (${res.status})` };
    return { name: 'auth endpoint', status: 'warn', detail: `unexpected ${res.status}` };
  } catch (err) {
    return { name: 'auth endpoint', status: 'fail', detail: err.message };
  }
}

function checkVersion() {
  return { name: 'version', status: 'pass', detail: `${pkg.name}@${pkg.version} on node ${process.version} (deviceId ${getDeviceId().slice(0, 8)}…)` };
}
