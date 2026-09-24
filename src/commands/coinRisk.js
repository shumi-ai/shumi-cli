import { apiGet } from '../lib/api-client.js';
import { renderOk, renderErr, spinner } from '../lib/output.js';
import { typedAction, addUniversalFlags } from '../lib/typedCmd.js';
import { withSchema } from '../lib/schema.js';
import { smartFormat } from '../lib/smartFormat.js';
import { formatPercentUnits } from './funding.js';
import { renderCoinLookup } from '../lib/currentTrend.js';

/**
 * Registers coin subcommands: risk, sentiment, historical, by-contract, by-id, by-name, lookup.
 * Called from coin.js so the entire coin tree lives under `shumi coin`.
 */
export function registerCoinRiskCommand(coinCmd) {
  const risk = coinCmd
    .command('risk')
    .argument('<symbols...>', 'one or more coin symbols (e.g. BTC ETH SOL)')
    .description('bundled risk context: price, funding, trend, sentiment, BTC correlation')
    .action(async function (symbols) {
      const opts = this.optsWithGlobals();
      const sp = spinner(`fetching risk for ${symbols.join(', ')}…`, opts);
      try {
        const envs = await Promise.all(symbols.map((s) =>
          apiGet(`coin/risk/${encodeURIComponent(s)}`).catch((e) => ({ _error: e, _symbol: s })),
        ));
        sp.stop();
        // If every fetch failed with the same auth-class error, surface it (exit 2/3).
        const allFailed = envs.every((e) => e._error);
        if (allFailed) {
          const firstErr = envs[0]._error;
          renderErr(firstErr, opts);
          return;
        }
        // If only one symbol and no error, render as single record
        if (envs.length === 1 && !envs[0]._error) {
          renderOk(envs[0], opts, (data) => renderSingleRisk(data));
          return;
        }
        // Multi-symbol: render as comparison
        const rows = envs.map((env, i) => {
          if (env._error) return { symbol: symbols[i].toUpperCase(), error: env._error.message };
          const d = env.data?.data || env.data;
          return d ? {
            symbol: d.symbol,
            price: d.price,
            funding_apr: d.funding_apr,
            funding_paying_side: d.funding_paying_side,
            funding_receiving_side: d.funding_receiving_side,
            carry_if_long: d.carry_if_long,
            carry_if_short: d.carry_if_short,
            trend_daily: d.trend_daily,
            trend_weekly: d.trend_weekly,
            sentiment: d.sentiment_stance,
            btc_corr: d.btc_correlation,
          } : { symbol: symbols[i].toUpperCase(), error: 'no data' };
        });
        const aggregate = {
          schemaVersion: 1,
          data: rows,
          meta: { ts: new Date().toISOString(), route: 'coin/risk (multi)' },
        };
        renderOk(aggregate, opts, (data, chalk) => smartFormat(data, chalk, opts));
      } catch (err) { sp.stop(); renderErr(err, opts); }
    });
  addUniversalFlags(risk);
  withSchema(risk, {
    kind: 'object or array',
    fields: {
      symbol: 'string',
      price: 'number',
      funding_apr: 'number — annualized rate in percent units (7.4 = 7.4%)',
      funding_paying_side: 'longs | shorts | null',
      funding_receiving_side: 'longs | shorts | null',
      carry_if_long: 'deterministic perpetual-position carry string',
      carry_if_short: 'deterministic perpetual-position carry string',
      trend_daily: 'string',
      trend_weekly: 'string',
      sentiment_stance: 'string',
      btc_correlation: 'number',
    },
    note: 'Funding applies to perpetual positions only; spot neither pays nor receives it. Single-symbol returns a flat object; multi-symbol returns an array, one row per symbol.',
  });

  addUniversalFlags(coinCmd
    .command('sentiment')
    .argument('<symbol>', 'coin symbol')
    .description('sentiment for a coin')
    .action(typedAction({
      route: (ctx) => `coin/sentiment/${encodeURIComponent(ctx.args[0])}`,
      spinner: (ctx) => `sentiment for ${ctx.args[0]}…`,
    })));

  coinCmd
    .command('historical')
    .argument('<symbol>', 'coin symbol')
    .description('historical metadata for a coin')
    .action(typedAction({
      route: (ctx) => `coin/historical/${encodeURIComponent(ctx.args[0])}`,
      spinner: (ctx) => `historical metadata for ${ctx.args[0]}…`,
    }));

  coinCmd
    .command('by-contract')
    .argument('<address>', 'contract address')
    .requiredOption('--chain <chain>', 'chain (ethereum, bsc, solana, etc.)')
    .description('look up a coin by contract address')
    .action(typedAction({
      route: (ctx) => `coin/by-contract/${encodeURIComponent(ctx.args[0])}`,
      query: (ctx, opts) => ({ chain: opts.chain }),
      spinner: (ctx) => `lookup by contract ${ctx.args[0].slice(0, 10)}…`,
    }));

  coinCmd
    .command('by-id')
    .argument('<id>', 'coin id (CoinGecko / internal)')
    .description('look up a coin by id')
    .action(typedAction({
      route: (ctx) => `coin/by-id/${encodeURIComponent(ctx.args[0])}`,
      spinner: (ctx) => `lookup by id ${ctx.args[0]}…`,
      human: renderCoinLookup,
    }));

  coinCmd
    .command('by-name')
    .argument('<name>', 'coin name')
    .description('look up a coin by name')
    .action(typedAction({
      route: (ctx) => `coin/by-name/${encodeURIComponent(ctx.args[0])}`,
      spinner: (ctx) => `lookup by name ${ctx.args[0]}…`,
      human: renderCoinLookup,
    }));

  coinCmd
    .command('lookup')
    .argument('<symbol>', 'coin symbol (typed equivalent of NLP `coin <symbol>`)')
    .description('typed coin lookup by symbol (no NLP)')
    .action(typedAction({
      route: 'coin/lookup',
      query: (ctx) => ({ symbol: ctx.args[0] }),
      spinner: (ctx) => `coin ${ctx.args[0]}…`,
      human: renderCoinLookup,
    }));
}

export function renderSingleRisk(envelope) {
  const d = envelope?.data?.data || envelope?.data || envelope;
  if (!d) return process.stdout.write('No data.\n');
  const lines = [
    ['symbol',          d.symbol],
    ['price',           d.price],
    ['funding APR',     formatPercentUnits(d.funding_apr)],
    ['funding pays',    d.funding_paying_side],
    ['funding receives', d.funding_receiving_side],
    ['carry if long',   d.carry_if_long],
    ['carry if short',  d.carry_if_short],
    ['trend (daily)',   `${d.trend_daily || '—'} since ${d.trend_daily_since || '—'}`],
    ['trend (weekly)',  `${d.trend_weekly || '—'} since ${d.trend_weekly_since || '—'}`],
    ['sentiment',       d.sentiment_stance],
    ['BTC corr',        d.btc_correlation],
  ];
  for (const [k, v] of lines) process.stdout.write(`${k.padEnd(16)} ${v ?? '—'}\n`);
  if (d.sentiment_summary) process.stdout.write(`\nsummary: ${d.sentiment_summary}\n`);
}
