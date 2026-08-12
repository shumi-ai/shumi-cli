/**
 * Update availability, made reachable by machines.
 *
 * `update-notifier` only ever *prints* — and it self-gates on
 * `process.stdout.isTTY` (update-notifier.js:130), so a user driving the CLI
 * from an AI agent (always non-TTY) can never be told an update exists. That
 * is not hypothetical: the 0.6.2 login-timeout fix shipped 2026-08-02 and a
 * customer was still hitting the bug six weeks later, because nothing in their
 * pipe-shaped session could surface the notice.
 *
 * So we split the two halves apart. The background *check* is not TTY-gated
 * and runs for everyone; the result lands here, where `renderOk`/`renderErr`
 * can put it in the JSON envelope and `doctor` can report it.
 */
import updateNotifier from 'update-notifier';

const ONE_DAY = 1000 * 60 * 60 * 24;

let info = null;

/**
 * Kick off the background registry check and capture its result.
 * Returns the notifier (so the caller can still `.notify()` for humans), or
 * null when disabled/unavailable. Never throws — an update check must not be
 * able to break a command.
 */
export function initUpdateCheck(pkg) {
  if (process.env.SHUMI_NO_UPDATE_NOTIFIER === '1') return null;
  try {
    const notifier = updateNotifier({ pkg, updateCheckInterval: ONE_DAY });

    // check() *consumes* the cached result: it reads the `update` key, then
    // deletes it, so only one run per 24h check window ever sees it. An agent
    // invoking the CLI 50x/day would be told on one run and left ignorant on
    // the other 49 — odds, not a channel. Put it back so every run can report
    // until the upgrade actually happens.
    if (notifier?.update && notifier.config) {
      try { notifier.config.set('update', notifier.update); } catch { /* configstore is best-effort */ }
    }

    const latest = notifier?.update?.latest;
    info = latest && isNewer(latest, pkg.version)
      ? { current: pkg.version, latest, action: `npm i -g ${pkg.name}@latest` }
      : null;

    return notifier;
  } catch {
    return null;
  }
}

/** The captured result, or null when up to date / unknown. */
export function getUpdateInfo() {
  return info;
}

/**
 * Numeric-triple version compare. Deliberately ignores prerelease tags so a
 * local 0.8.0-dev build is never nagged about the registry's 0.7.4 — the
 * re-persisted cache above means this runs on every invocation, and a false
 * positive would be permanent noise rather than a one-off.
 */
export function isNewer(latest, current) {
  const parts = (v) => String(v).split('.').map((n) => Number.parseInt(n, 10) || 0);
  const a = parts(latest);
  const b = parts(current);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

/** Test seam — resets the module-level capture between cases. */
export function __setUpdateInfo(next) {
  info = next;
}
