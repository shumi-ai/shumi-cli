import { typedAction, addUniversalFlags } from '../lib/typedCmd.js';

/**
 * Token unlocks (coinrotator-ai /api/cli/unlocks/*):
 *   shumi unlocks coin ARB        one coin's schedule: next unlock, 30/90-day releases,
 *                                 recipients, past-unlock price history, sources
 *   shumi unlocks calendar        upcoming unlocks across the market, ranked by % of market cap
 */
export function registerUnlocksCommand(program) {
  const unlocks = program.command('unlocks').description('scheduled token unlocks: one coin, or the market-wide calendar');

  addUniversalFlags(unlocks
    .command('coin')
    .argument('<symbol>', 'coin symbol, e.g. ARB')
    .option('--coin-id <id>', 'coin id (e.g. arbitrum) when several coins share the ticker')
    .description("a coin's unlock schedule: next unlock, size, recipients, sources")
    .action(typedAction({
      route: (ctx) => `unlocks/${encodeURIComponent(ctx.args[0])}`,
      query: (ctx, opts) => ({ ...(opts.coinId && { coinId: opts.coinId }) }),
      spinner: (ctx) => `unlocks for ${ctx.args[0]}…`,
    })));

  addUniversalFlags(unlocks
    .command('calendar')
    .option('--days <n>', 'window in days from today, 1-30 (default 7)')
    .option('--max-rank <n>', 'only coins up to this market-cap rank (default 500)')
    .option('--min-pct <n>', 'minimum size in % of market cap (default and floor 0.5)')
    .option('--sort <by>', 'pct (default) | usd | date')
    .option('--limit <n>', 'rows, 1-50 (default 15)')
    .option('--insiders', 'only unlocks with a team or investor leg')
    .description('upcoming unlocks across the market, ranked by % of market cap')
    .action(typedAction({
      route: 'unlocks/calendar',
      query: (ctx, opts) => ({
        ...(opts.days && { days: opts.days }),
        ...(opts.maxRank && { maxRank: opts.maxRank }),
        ...(opts.minPct && { minPct: opts.minPct }),
        ...(opts.sort && { sort: opts.sort }),
        ...(opts.limit && { limit: opts.limit }),
        ...(opts.insiders && { insidersOnly: 'true' }),
      }),
      spinner: 'unlock calendar…',
    })));
}
