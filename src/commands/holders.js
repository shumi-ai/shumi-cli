import { typedAction } from '../lib/typedCmd.js';

export function registerHoldersCommand(program) {
  const holders = program.command('holders').description('large-holder tracking');

  holders.command('watchlist')
    .description('list watched contracts')
    .action(typedAction({ route: 'holders', query: { action: 'watchlist' }, spinner: 'holders watchlist…' }));

  holders.command('movements')
    .requiredOption('--contract <address>', 'token contract address')
    .option('--limit <n>', 'max results')
    .description('large-holder movements for a contract')
    .action(typedAction({
      route: 'holders',
      query: (ctx, opts) => ({ action: 'movements', contract: opts.contract, ...(opts.limit && { limit: opts.limit }) }),
      spinner: (ctx, opts) => `holder movements for ${opts.contract.slice(0, 10)}…`,
    }));
}
