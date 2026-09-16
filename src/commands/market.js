import { apiGet } from '../lib/api-client.js';
import { renderOk, renderErr, spinner } from '../lib/output.js';
import { typedAction } from '../lib/typedCmd.js';
import { formatPrice, formatRelative } from '../lib/smartFormat.js';

export function registerMarketCommand(program) {
  const market = program
    .command('market')
    .description('market-wide data (health, global, crossing, prices, baselines)')
    .action(typedAction({
      route: 'market/health',
      spinner: 'market health…',
    }));

  market
    .command('health')
    .description('market health (UP/HODL/DOWN distribution)')
    .option('--context', 'include full context bundle')
    .action(typedAction({
      route: 'market/health',
      query: (ctx, opts) => (opts.context ? { context: '1' } : {}),
      spinner: 'market health…',
    }));

  market
    .command('global')
    .description('global market aggregates (BTC dominance, total mcap, etc.)')
    .action(typedAction({ route: 'market/global', spinner: 'global market…' }));

  market
    .command('crossing')
    .description('market regime trend-crossing signals')
    .action(typedAction({ route: 'market/crossing', spinner: 'market crossing…' }));

  market
    .command('baselines')
    .description('time-based price baselines (4h/24h/7d)')
    .option('--symbols <list>', 'comma-separated symbols')
    .option('--horizons <list>', 'comma-separated horizons (4h,24h,7d)')
    .action(typedAction({
      route: 'market/baselines',
      query: (ctx, opts) => ({
        ...(opts.symbols && { symbols: opts.symbols }),
        ...(opts.horizons && { horizons: opts.horizons }),
      }),
      spinner: 'market baselines…',
    }));

  market
    .command('prices')
    .description('bulk live prices (optionally with 4h/24h/7d baselines)')
    .option('--symbols <list>', 'comma-separated symbols (e.g. BTC,ETH,SOL)')
    .option('--baselines', 'include 4h/24h/7d baseline overlay')
    .action(async function () {
      const opts = this.optsWithGlobals();
      const sp = spinner('fetching prices…', opts);
      try {
        const env = await apiGet('market/prices', {
          ...(opts.symbols && { symbols: opts.symbols }),
          ...(opts.baselines && { baselines: '1' }),
        });
        sp.stop();
        renderOk(env, opts, (d, chalk) => {
          const prices = d.prices || d;
          const baselines = d.baselines;
          const entries = Object.entries(prices).slice(0, 50);
          const head = baselines
            ? 'SYMBOL'.padEnd(12) + 'PRICE'.padEnd(14) + '4h'.padEnd(10) + '24h'.padEnd(10) + '7d'
            : 'SYMBOL'.padEnd(12) + 'PRICE'.padEnd(14) + 'SOURCE'.padEnd(12) + 'AS OF';
          process.stdout.write(chalk.bold(head) + '\n');
          for (const [k, v] of entries) {
            // Upstream rows are objects { price, source, ts }; tolerate a bare
            // scalar too. Previously `String(v)` printed "[object Object]".
            const isObj = v && typeof v === 'object';
            const raw = isObj ? v.price : v;
            // Number(null) / Number('') are 0 — guard so a missing price shows
            // "—", not a confident "$0.000".
            const priceNum = raw == null || raw === '' ? NaN : Number(raw);
            const priceStr = (Number.isFinite(priceNum) ? formatPrice(priceNum) : '—').padEnd(14);
            const label = k.toUpperCase().padEnd(12);
            if (baselines) {
              const b = baselines?.[k] || {};
              process.stdout.write(label + priceStr + `${fmt(b.b4h)} ${fmt(b.b24h)} ${fmt(b.b7d)}\n`);
            } else {
              const source = String(isObj && v.source ? v.source : '—').padEnd(12);
              const age = isObj && v.ts ? ageOf(v.ts) : '';
              process.stdout.write(label + priceStr + chalk.dim(source + age) + '\n');
            }
          }
          if (Object.keys(prices).length > 50) {
            process.stdout.write(chalk.dim(`\n(showing 50 of ${Object.keys(prices).length}; pass --json for all)\n`));
          }
        });
      } catch (err) { sp.stop(); renderErr(err, opts); }
    });
}

function fmt(n) {
  if (n === null || n === undefined) return '—'.padEnd(10);
  return String(Number(n).toPrecision(5)).padEnd(10);
}

// Relative age from a row timestamp (ISO string or epoch s/ms) → "12s ago".
function ageOf(ts) {
  const ms = typeof ts === 'number' ? (ts < 1e12 ? ts * 1000 : ts) : Date.parse(ts);
  if (Number.isNaN(ms)) return '';
  return formatRelative(Math.max(0, (Date.now() - ms) / 1000));
}
