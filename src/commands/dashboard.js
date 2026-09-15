import chalk from 'chalk';
import { apiGet, ApiError } from '../lib/api-client.js';
import { renderOk, renderErr, spinner, resolveMode } from '../lib/output.js';
import { withSchema } from '../lib/schema.js';
import { getToken } from '../lib/config.js';
import { runSignal } from './signal.js';
import { formatPercentUnits } from './funding.js';

/**
 * The default `shumi` invocation (no subcommand) prints a "what's happening
 * right now" market overview — first impression of the tool. Optimized for
 * the first 5 seconds a new user sees.
 *
 * Falls back to `program.help()` only if the user is unauthenticated AND
 * passes --help. With an API key or JWT in place, run the dashboard.
 *
 * Fan-out: market global + market prices (BTC/ETH/SOL) + funding momentum +
 * regime active + sentiment market (parallel). If any fails we just skip
 * that section — never block the whole dashboard.
 */
export function registerDashboardAction(program) {
  program
    .argument('[symbol]', 'coin symbol for a quick signal (e.g. BTC); omit for market overview')
    .action(async (symbol, _options, cmd) => {
    const opts = cmd.optsWithGlobals();

    // Reject unknown commands. Commander routes any unrecognized subcommand to
    // this default action with the bad token in cmd.args. Without this guard a
    // typo (`shumi signl BTC`) silently runs the dashboard, exits 0 (an agent
    // reads that as success), and burns metered queries on the fan-out below.
    //
    // Threshold is >1, not >0, because the bare-ticker shortcut below is itself
    // a single positional: `shumi BTC` arrives as cmd.args === ['BTC']. Two or
    // more operands can never be the shortcut, so they are always a bad command.
    // A lone typo (`shumi signl`) falls through to runSignal and fails on the
    // unknown symbol — still a non-zero exit, which is the bug this fixes.
    if (cmd.args.length > 1) {
      const unknown = cmd.args[0];
      renderErr({ envelope: { schemaVersion: 1, error: { code: 'BAD_REQUEST', message: `unknown command '${unknown}'. Run: shumi --help` } } }, opts);
      return;
    }

    // Bare ticker shortcut: `shumi BTC` → quick signal, no subcommand needed.
    // (Subcommand names take precedence, so `shumi signal`, `shumi help`, etc.
    // still dispatch normally.)
    //
    // Extra operands mean this was never a ticker. `shumi marekt health` — a
    // typo of `market` — used to bind "marekt" to [symbol], silently discard
    // "health", and go on to render a signal for a coin named MAREKT. Every
    // mistyped subcommand became a plausible-looking reading of a nonexistent
    // coin, so refuse the guess rather than answer the wrong question.
    const operands = cmd.args || [];
    if (operands.length > 1) {
      renderErr(
        new ApiError(400, {
          error: {
            code: 'BAD_REQUEST',
            message: `Unknown command: ${operands.join(' ')}. Run \`shumi --help\` for the command list.`,
          },
        }),
        opts,
      );
      return;
    }

    if (symbol) {
      await runSignal(symbol.toUpperCase(), opts);
      return;
    }

    // Unauthenticated → fall back to help so first-time users see the surface.
    if (!getToken()) {
      cmd.help();
      return;
    }

    const mode = resolveMode(opts);
    const sp = spinner('loading market…', opts);

    try {
      const [pricesRes, fundingRes, regimeRes, sentimentRes, tierRes] = await Promise.allSettled([
        apiGet('market/prices', { symbols: 'BTC,ETH,SOL' }),
        apiGet('funding/momentum'),
        apiGet('regime', { action: 'active' }),
        apiGet('sentiment', { action: 'market' }),
        apiGet('billing/tier'),
      ]);
      sp.stop();

      const data = {
        prices: pricesRes.status === 'fulfilled' ? pricesRes.value.data : null,
        funding: fundingRes.status === 'fulfilled' ? fundingRes.value.data : null,
        regime: regimeRes.status === 'fulfilled' ? regimeRes.value.data : null,
        sentiment: sentimentRes.status === 'fulfilled' ? sentimentRes.value.data : null,
        tier: tierRes.status === 'fulfilled' ? tierRes.value.data : null,
      };

      if (mode.json) {
        renderOk({ schemaVersion: 1, data, meta: { ts: new Date().toISOString(), route: 'dashboard' } }, opts);
        return;
      }

      renderHuman(data);
    } catch (err) {
      sp.stop();
      renderErr(err, opts);
    }
  });
}

export function registerDashboardSchema(program) {
  // Schema for the default action — agents reading `shumi commands --json`
  // see what `shumi` (no args) returns.
  withSchema(program, {
    kind: 'object',
    fields: {
      prices: 'object — { bitcoin, ethereum, solana } each with price/source/ts',
      funding: 'object — market funding momentum {market, distribution, assets}',
      regime: 'object — { positions[], meta }',
      sentiment: 'object — market sentiment summary',
      tier: 'object — { tier, source, expiresAt }',
    },
  });
}

function renderHuman(d) {
  // Header
  const ts = new Date().toISOString().slice(11, 19) + 'Z';
  process.stdout.write('\n');
  process.stdout.write(chalk.bold('  shumi') + chalk.dim(' · market overview · ') + chalk.dim(ts) + '\n');
  process.stdout.write(chalk.dim('  ' + '─'.repeat(58)) + '\n');

  // Prices block
  if (d.prices?.prices) {
    process.stdout.write('\n');
    process.stdout.write(chalk.dim('  PRICES') + '\n');
    for (const [id, v] of Object.entries(d.prices.prices)) {
      const sym = id.slice(0, 8).toUpperCase().padEnd(9);
      const price = formatPrice(v?.price);
      process.stdout.write(`  ${chalk.bold(sym)} ${price.padStart(12)} ${chalk.dim((v?.source || '—').padStart(8))}\n`);
    }
  }

  // Funding block
  if (d.funding?.market) {
    const m = d.funding.market;
    process.stdout.write('\n');
    process.stdout.write(chalk.dim('  FUNDING') + '\n');
    const tempColor = (m.temperature || '').toLowerCase().includes('hot') ? chalk.red
      : (m.temperature || '').toLowerCase().includes('cool') ? chalk.cyan
      : chalk.yellow;
    process.stdout.write(`  market temp ${tempColor(m.temperature || '—')}  avg APR ${formatPercentUnits(m.avgApr)}  ${chalk.green('+'+(m.positive ?? '?'))}/${chalk.red('-'+(m.negative ?? '?'))} of ${m.total ?? '?'}\n`);
  }

  // Regime block
  if (d.regime?.positions) {
    process.stdout.write('\n');
    process.stdout.write(chalk.dim('  REGIME') + '\n');
    process.stdout.write(`  ${d.regime.positions.length} active position(s) market-wide\n`);
  }

  // Sentiment block — show top 3 by recency from data array
  if (d.sentiment?.data?.length) {
    process.stdout.write('\n');
    process.stdout.write(chalk.dim('  SENTIMENT (market)') + '\n');
    const summaryItem = d.sentiment.data.find((s) => s?.summary) || d.sentiment.data[0];
    if (summaryItem?.summary) {
      const summary = String(summaryItem.summary).slice(0, 200).replace(/\s+/g, ' ');
      process.stdout.write(`  ${summary}${summaryItem.summary.length > 200 ? '…' : ''}\n`);
    }
  }

  // Footer with tier + hints
  process.stdout.write('\n');
  process.stdout.write(chalk.dim('  ' + '─'.repeat(58)) + '\n');
  if (d.tier) {
    const tierLabel = d.tier.tier === 'pro' ? chalk.green('pro')
      : d.tier.tier === 'access' ? chalk.cyan('access')
      : chalk.dim('free');
    process.stdout.write(`  tier ${tierLabel}  ·  ${chalk.dim('try: shumi signal BTC  ·  shumi watch funding  ·  shumi commands')}\n`);
  } else {
    process.stdout.write('  ' + chalk.dim('try: shumi signal BTC  ·  shumi watch funding  ·  shumi commands') + '\n');
  }
  process.stdout.write('\n');
}

function formatPrice(p) {
  if (p === null || p === undefined || Number.isNaN(Number(p))) return '—';
  const n = Number(p);
  if (n >= 1000) return '$' + n.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (n >= 1)    return '$' + n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  return '$' + n.toPrecision(4);
}
