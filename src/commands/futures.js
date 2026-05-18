import { typedAction, addUniversalFlags } from '../lib/typedCmd.js';

export function registerFuturesCommand(program) {
  const futures = program.command('futures').description('futures signal state, log, history');

  futures.command('state')
    .description('current futures signal state')
    .action(typedAction({ route: 'futures', query: { action: 'state' }, spinner: 'futures state…' }));

  futures.command('log')
    .description('futures signal log')
    .action(typedAction({ route: 'futures', query: { action: 'log' }, spinner: 'futures log…' }));

  futures.command('history')
    .argument('<asset>', 'asset symbol (e.g. BTC, ETH)')
    .description('futures history for an asset')
    .action(typedAction({
      route: 'futures',
      query: (ctx) => ({ action: 'history', asset: ctx.args[0] }),
      spinner: (ctx) => `futures history for ${ctx.args[0]}…`,
    }));
}
