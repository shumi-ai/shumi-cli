import { typedAction, addUniversalFlags } from '../lib/typedCmd.js';

/**
 * Typed trends commands. Replaces the prior NLP-only `shumi trends`.
 * Default action (no subcommand) returns fresh trends.
 */
export function registerTrendsCommand(program) {
  const trends = program
    .command('trends')
    .description('trend analysis (fresh, stale, aligned, extreme, historical)')
    .option('--limit <n>', 'max results')
    .option('--interval <interval>', 'trend interval (1d, 1w)')
    .action(typedAction({
      route: 'trends',
      query: (ctx, opts) => ({ action: 'fresh', ...(opts.limit && { limit: opts.limit }), ...(opts.interval && { interval: opts.interval }) }),
      spinner: 'fresh trends…',
    }));

  for (const action of ['fresh', 'stale', 'aligned', 'extreme', 'historical']) {
    trends.command(action)
      .description(`${action} trends`)
      .option('--limit <n>', 'max results')
      .option('--interval <interval>', 'trend interval (1d, 1w)')
      .action(typedAction({
        route: 'trends',
        query: (ctx, opts) => ({ action, ...(opts.limit && { limit: opts.limit }), ...(opts.interval && { interval: opts.interval }) }),
        spinner: `${action} trends…`,
      }));
  }
}
