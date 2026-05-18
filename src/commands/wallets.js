import { typedAction } from '../lib/typedCmd.js';

export function registerWalletsCommand(program) {
  const wallets = program.command('wallets').description('smart-wallet tracking');

  wallets.command('watchlist')
    .description('list watched wallets')
    .action(typedAction({ route: 'wallets', query: { action: 'watchlist' }, spinner: 'wallets watchlist…' }));

  wallets.command('movements')
    .requiredOption('--address <address>', 'wallet address')
    .option('--limit <n>', 'max results')
    .description('movements for a smart wallet')
    .action(typedAction({
      route: 'wallets',
      query: (ctx, opts) => ({ action: 'movements', address: opts.address, ...(opts.limit && { limit: opts.limit }) }),
      spinner: (ctx, opts) => `wallet movements for ${opts.address.slice(0, 10)}…`,
    }));
}
