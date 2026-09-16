import chalk from 'chalk';
import { apiGet } from '../lib/api-client.js';
import { renderOk, renderErr, spinner, resolveMode } from '../lib/output.js';
import { withSchema } from '../lib/schema.js';
import { getToken } from '../lib/config.js';

/**
 * `shumi brief` (alias `digest`) — a one-screen, severity-ordered trader
 * digest, porting the Telegram bot's morning-brief format to the terminal:
 *
 *   SUMMARY  → open positions  → recent exits  → pending watch
 *
 * Fan-out (parallel, skip-on-fail like `dashboard`): regime active +
 * walkforward positions (open) + walkforward outcomes (closed) + futures
 * state (pending signals). Any section that fails is simply omitted; the
 * brief never blocks on one bad upstream.
 *
 * Typed surface, so it needs auth. Anon callers get a clear login hint
 * instead of a wall of AUTH_REQUIRED errors.
 *
 * Field shapes verified against coinrotator-ai source:
 *   regime/active     → { positions:[{symbol,direction,entryPrice,currentPrice,holdDays,entry:{regimeAtSignal}}], meta }
 *   walkforward/positions → { positions:[{symbol,direction,entryPrice,currentPrice,holdDays}], meta }
 *   walkforward/outcomes  → { outcomes:[{symbol,direction,entryPrice,exitPrice,returnPct,holdDays,exitReason,exitDate}], summary:{total,wins,losses,winRate} }
 *   futures/state     → { signals:[{asset,direction,regime,conviction,signalType,resolvedAt,lastSeenAt}], meta }
 */
export function registerBriefCommand(program) {
  program
    .command('brief')
    .alias('digest')
    .description('one-screen trader digest (positions, exits, pending watch)')
    .option('--exits <n>', 'number of recent exits to show', '5')
    .option('--watch <n>', 'number of pending watch signals to show', '5')
    .action(async function () {
      const opts = this.optsWithGlobals();
      const mode = resolveMode(opts);

      if (!getToken()) {
        const err = {
          status: 401,
          body: { error: { code: 'AUTH_REQUIRED', message: 'brief reads your tracked positions — run: shumi login (or set SHUMI_TOKEN)' } },
        };
        renderErr(err, opts);
        process.exitCode = 2;
        return;
      }

      const sp = spinner('building brief…', opts);
      try {
        const [regimeRes, wfPosRes, wfOutRes, futRes] = await Promise.allSettled([
          apiGet('regime', { action: 'active' }),
          apiGet('walkforward', { action: 'positions' }),
          apiGet('walkforward', { action: 'outcomes' }),
          apiGet('futures', { action: 'state' }),
        ]);
        sp.stop();

        const data = {
          regimePositions: regimeRes.status === 'fulfilled' ? (regimeRes.value.data?.positions ?? []) : null,
          walkforwardPositions: wfPosRes.status === 'fulfilled' ? (wfPosRes.value.data?.positions ?? []) : null,
          outcomes: wfOutRes.status === 'fulfilled' ? (wfOutRes.value.data?.outcomes ?? []) : null,
          outcomesSummary: wfOutRes.status === 'fulfilled' ? (wfOutRes.value.data?.summary ?? null) : null,
          watch: futRes.status === 'fulfilled' ? (futRes.value.data?.signals ?? []) : null,
        };

        if (mode.json) {
          renderOk({ schemaVersion: 1, data, meta: { ts: new Date().toISOString(), route: 'brief' } }, opts);
          return;
        }

        renderHuman(data, { exits: clampInt(opts.exits, 5), watch: clampInt(opts.watch, 5) });
      } catch (err) {
        sp.stop();
        renderErr(err, opts);
      }
    });
}

export function registerBriefSchema(program) {
  withSchema(program.commands.find((c) => c.name() === 'brief'), {
    kind: 'object',
    fields: {
      regimePositions: 'array — open regime positions [{symbol,direction,entryPrice,currentPrice,holdDays}]',
      walkforwardPositions: 'array — open walkforward positions [{symbol,direction,entryPrice,currentPrice,holdDays}]',
      outcomes: 'array — recently closed trades [{symbol,direction,returnPct,holdDays,exitReason,exitDate}]',
      outcomesSummary: 'object — { total, wins, losses, winRate }',
      watch: 'array — pending futures signals [{asset,direction,regime,conviction,signalType}]',
    },
  });
}

// ───────── rendering ─────────

function renderHuman(d, limits) {
  const ts = new Date().toISOString().slice(0, 16).replace('T', ' ') + 'Z';
  out('\n');
  out(chalk.bold('  shumi brief') + chalk.dim(' · ' + ts) + '\n');
  out(chalk.dim('  ' + '─'.repeat(58)) + '\n');

  // SUMMARY line — counts + win rate (verified from outcomes.summary)
  const openPositions = [...(d.regimePositions ?? []), ...(d.walkforwardPositions ?? [])];
  const watchActive = (d.watch ?? []).filter((s) => !s?.resolvedAt);
  const sum = d.outcomesSummary;
  const wr = sum && Number.isFinite(Number(sum.winRate)) ? `${(Number(sum.winRate) * 100).toFixed(0)}% WR` : null;
  out('\n');
  out(
    '  ' +
      chalk.dim('SUMMARY  ') +
      `${chalk.bold(openPositions.length)} open · ${chalk.bold(watchActive.length)} watching` +
      (sum ? ` · ${sum.total ?? '?'} closed${wr ? ` (${wr})` : ''}` : '') +
      '\n'
  );

  // POSITIONS — open, with entry→current and computed P&L%
  out('\n');
  out(chalk.dim('  📍 POSITIONS') + (openPositions.length ? '' : chalk.dim('  (none)')) + '\n');
  for (const p of openPositions) {
    out('  ' + positionLine(p) + '\n');
  }

  // EXITS — recent closed trades
  const exits = (d.outcomes ?? []).slice().sort(byExitDateDesc).slice(0, limits.exits);
  out('\n');
  out(chalk.dim('  ⚠ RECENT EXITS') + (exits.length ? '' : chalk.dim('  (none)')) + '\n');
  for (const e of exits) {
    out('  ' + exitLine(e) + '\n');
  }

  // WATCH — pending signals
  const watch = watchActive.slice(0, limits.watch);
  out('\n');
  out(chalk.dim('  🔮 WATCH') + (watch.length ? '' : chalk.dim('  (none)')) + '\n');
  for (const w of watch) {
    out('  ' + watchLine(w) + '\n');
  }

  out('\n');
  out(chalk.dim('  ' + '─'.repeat(58)) + '\n');
  out('  ' + chalk.dim('signal entries, not portfolio instructions · shumi signal <sym> for detail') + '\n\n');
}

function positionLine(p) {
  const dir = dirGlyph(p?.direction);
  const sym = String(p?.symbol ?? '?').toUpperCase().padEnd(7);
  const pct = pnlPct(p?.entryPrice, p?.currentPrice, p?.direction);
  const move =
    p?.currentPrice != null
      ? `${fmtPrice(p.entryPrice)} → ${fmtPrice(p.currentPrice)}  ${pnlColor(pct)}`
      : `${fmtPrice(p.entryPrice)} ${chalk.dim('(no live price)')}`;
  const held = Number.isFinite(Number(p?.holdDays)) ? chalk.dim(` ${p.holdDays}d`) : '';
  return `${dir} ${chalk.bold(sym)} ${move}${held}`;
}

function exitLine(e) {
  const dir = dirGlyph(e?.direction);
  const sym = String(e?.symbol ?? '?').toUpperCase().padEnd(7);
  const pct = Number(e?.returnPct);
  const ret = Number.isFinite(pct) ? pnlColor(pct) : chalk.dim('—');
  const held = Number.isFinite(Number(e?.holdDays)) ? chalk.dim(`${e.holdDays}d`) : '';
  const reason = e?.exitReason ? chalk.dim(` ${e.exitReason}`) : '';
  return `${dir} ${chalk.bold(sym)} ${ret} ${held}${reason}`;
}

function watchLine(w) {
  const dir = w?.direction ? dirGlyph(w.direction) + ' ' : '';
  const sym = String(w?.asset ?? '?').toUpperCase().padEnd(7);
  const kind = w?.signalType ? chalk.dim(w.signalType) : '';
  const regime = w?.regime ? chalk.dim(` · ${w.regime}`) : '';
  const conv = w?.conviction ? ` · ${w.conviction}` : '';
  return `${dir}${chalk.bold(sym)} ${kind}${regime}${conv}`;
}

// ───────── helpers ─────────

// P&L% computed from entry/current/direction — robust regardless of how the
// upstream encodes unrealizedPnl (absolute vs percent).
function pnlPct(entry, current, direction) {
  if (entry == null || current == null) return null; // Number(null) === 0 would read as -100%
  const e = Number(entry);
  const c = Number(current);
  if (!Number.isFinite(e) || !Number.isFinite(c) || e === 0) return null;
  const raw = ((c - e) / e) * 100;
  return String(direction).toLowerCase() === 'short' ? -raw : raw;
}

function pnlColor(pct) {
  if (pct === null || pct === undefined || !Number.isFinite(Number(pct))) return chalk.dim('—');
  const n = Number(pct);
  const s = `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`;
  return n >= 0 ? chalk.green(s) : chalk.red(s);
}

function dirGlyph(direction) {
  const d = String(direction ?? '').toLowerCase();
  if (d === 'long') return chalk.green('▲');
  if (d === 'short') return chalk.red('▼');
  return chalk.dim('•');
}

function fmtPrice(p) {
  if (p === null || p === undefined || Number.isNaN(Number(p))) return '—';
  const n = Number(p);
  if (n >= 1000) return '$' + n.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (n >= 1) return '$' + n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  return '$' + n.toPrecision(4);
}

function byExitDateDesc(a, b) {
  return String(b?.exitDate ?? '').localeCompare(String(a?.exitDate ?? ''));
}

function clampInt(v, dflt) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 50) : dflt;
}

function out(s) {
  process.stdout.write(s);
}

// Exposed for unit tests. Not part of the public CLI surface.
export const __test = { pnlPct, fmtPrice, dirGlyph, clampInt, byExitDateDesc, positionLine, exitLine, watchLine };
