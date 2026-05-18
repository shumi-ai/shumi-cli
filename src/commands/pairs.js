import { typedAction, addUniversalFlags } from '../lib/typedCmd.js';

export function registerPairsCommand(program) {
  const pairs = program.command('pairs').description('pair-trading signals, history, delta-neutral');

  pairs.command('suggestions')
    .description('pair trading suggestions')
    .option('--symbol <symbol>', 'filter by symbol')
    .option('--limit <n>', 'max results')
    .action(typedAction({
      route: 'pairs',
      query: (ctx, opts) => ({ action: 'suggestions', ...(opts.symbol && { symbol: opts.symbol }), ...(opts.limit && { limit: opts.limit }) }),
      spinner: 'pair suggestions…',
    }));

  pairs.command('history')
    .description('pair trading backtest history')
    .action(typedAction({ route: 'pairs', query: { action: 'history' }, spinner: 'pair history…' }));

  pairs.command('signal')
    .requiredOption('--token-a <symbol>', 'first token symbol (e.g. eth)')
    .requiredOption('--token-b <symbol>', 'second token symbol (e.g. sol)')
    .description('current pair signal state for a specific pair')
    .action(typedAction({
      route: 'pairs',
      query: (ctx, opts) => ({ action: 'signal', tokenA: opts.tokenA, tokenB: opts.tokenB }),
      spinner: (ctx, opts) => `pair signal ${opts.tokenA}/${opts.tokenB}…`,
    }));

  pairs.command('delta-neutral')
    .description('delta-neutral funding-rate arbitrage suggestions')
    .option('--exchange <name>', 'filter by exchange')
    .option('--dex-only', 'DEX exchanges only')
    .option('--symbol <symbol>', 'filter by symbol')
    .option('--limit <n>', 'max results')
    .action(typedAction({
      route: 'pairs',
      query: (ctx, opts) => ({
        action: 'delta-neutral',
        ...(opts.exchange && { exchange: opts.exchange }),
        ...(opts.dexOnly && { 'dex-only': '1' }),
        ...(opts.symbol && { symbol: opts.symbol }),
        ...(opts.limit && { limit: opts.limit }),
      }),
      spinner: 'delta-neutral…',
    }));
}
