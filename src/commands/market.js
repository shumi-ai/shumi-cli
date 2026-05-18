import { apiGet } from '../lib/api-client.js';
import { renderOk, renderErr, spinner } from '../lib/output.js';
import { typedAction } from '../lib/typedCmd.js';

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
        renderOk(env, opts, (d) => {
          const prices = d.prices || d;
          const baselines = d.baselines;
          const entries = Object.entries(prices).slice(0, 50);
          process.stdout.write('symbol              price          ' + (baselines ? '4h         24h        7d\n' : '\n'));
          for (const [k, v] of entries) {
            const b = baselines?.[k] || {};
            const line = `${k.padEnd(20)} ${String(v).padEnd(14)}`;
            const extras = baselines ? ` ${fmt(b.b4h)} ${fmt(b.b24h)} ${fmt(b.b7d)}` : '';
            process.stdout.write(line + extras + '\n');
          }
          if (Object.keys(prices).length > 50) {
            process.stdout.write(`(showing 50 of ${Object.keys(prices).length}; pass --json for all)\n`);
          }
        });
      } catch (err) { sp.stop(); renderErr(err, opts); }
    });
}

function fmt(n) {
  if (n === null || n === undefined) return '—'.padEnd(10);
  return String(Number(n).toPrecision(5)).padEnd(10);
}
