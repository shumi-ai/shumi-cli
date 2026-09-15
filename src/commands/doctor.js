import chalk from 'chalk';
import { createRequire } from 'module';
import { API_URL, getToken, getRawToken, getDeviceId, CONFIG_FILE } from '../lib/config.js';
import { inspectToken } from '../lib/token.js';
import { authExpiryNotice, describeExpiry } from '../lib/authNotice.js';
import { resolveMode } from '../lib/output.js';
import { isNewer } from '../lib/updateCheck.js';
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
      checks.push(await checkVersion());

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
  // getRawToken, not getToken: the latter returns null once expired, which
  // would report an aged-out session as "never logged in" — the exact
  // confusion this command exists to clear up. README promises doctor tells
  // you when a token expires, so actually say it.
  const token = getRawToken();
  if (!token) return { name: 'auth token', status: 'warn', detail: 'no token (run: shumi login or set SHUMI_TOKEN)' };
  const info = inspectToken(token);
  if (info.expired) {
    return { name: 'auth token', status: 'fail', detail: `JWT expired ${info.expiresAt} — run: shumi login` };
  }
  const expiry = info.expiresAt ? `, expires ${info.expiresAt.slice(0, 10)}` : '';
  // Grade the remaining time, don't just print the date. These sessions have no
  // refresh (exp === refreshExp), so the only warning a user ever gets is the
  // one we choose to give — 'warn' keeps doctor's exit code at 0 while still
  // showing yellow.
  const soon = authExpiryNotice();
  if (soon) {
    // Both facts, once each: the countdown is a floor (2.9 days reads as 2),
    // so the date is what makes it unambiguous.
    return { name: 'auth token', status: 'warn', detail: `${info.kind} ${describeExpiry(soon)} (${soon.expiresAt.slice(0, 10)}) — run: shumi login` };
  }
  return { name: 'auth token', status: 'pass', detail: `${info.kind} present${expiry}` };
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
  // Acceptance only — no expiry date here. `checkToken` above already reports
  // expiry (and grades the remaining time), so restating it printed the same
  // fact in two rows of one `shumi doctor` run.
  return { name: 'auth validity', status: 'pass', detail: 'JWT valid (local check — no quota used)' };
}

/**
 * Version freshness. Asks the npm registry directly rather than trusting the
 * update-notifier cache: that cache is empty on a first run and disabled
 * outright in CI, and "am I on a version with known-fixed bugs" is the single
 * question this command exists to answer honestly.
 *
 * registry.npmjs.org is not the Shumi API, so this spends no query quota.
 */
async function checkVersion() {
  const local = `${pkg.name}@${pkg.version} on node ${process.version} (deviceId ${getDeviceId().slice(0, 8)}…)`;
  // No `accept: …install-v1+json` here: that abbreviated-metadata type applies
  // to the packument root, and on /latest the registry answers 200 with an
  // empty body — which parsed as "no latest known" and reported healthy. A
  // freshness check that silently degrades to a pass is worse than none.
  let latest = null;
  try {
    const res = await fetch(`https://registry.npmjs.org/${pkg.name}/latest`, {
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) latest = (await res.json())?.version || null;
  } catch { /* offline — reported below as unknown, not as up to date */ }

  if (!latest) {
    return { name: 'version', status: 'warn', detail: `${local}; could not reach the npm registry to check for updates` };
  }
  if (isNewer(latest, pkg.version)) {
    return {
      name: 'version',
      status: 'warn',
      detail: `${pkg.version} is behind ${latest} — run: npm i -g ${pkg.name}@latest`,
    };
  }
  return { name: 'version', status: 'pass', detail: `${local}, latest` };
}
