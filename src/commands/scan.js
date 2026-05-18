import { typedAction, addUniversalFlags } from '../lib/typedCmd.js';

/**
 * Typed scan command. Forwards filter params straight to the server.
 */
export function registerScanCommand(program) {
  program
    .command('scan')
    .description('filter coins by trend, category, market cap, exchange')
    .option('--trend <direction>', 'filter by trend (UP, HODL, DOWN)')
    .option('--category <name>', 'filter by category')
    .option('--mcap-min <n>', 'minimum market cap in USD')
    .option('--mcap-max <n>', 'maximum market cap in USD')
    .option('--exchange <name>', 'filter by exchange')
    .option('--interval <interval>', 'trend interval (1d, 1w)')
    .option('--limit <n>', 'max results')
    .action(typedAction({
      route: 'scan',
      query: (ctx, opts) => ({
        ...(opts.trend && { trend: opts.trend }),
        ...(opts.category && { category: opts.category }),
        ...(opts.mcapMin && { mcap_min: opts.mcapMin }),
        ...(opts.mcapMax && { mcap_max: opts.mcapMax }),
        ...(opts.exchange && { exchange: opts.exchange }),
        ...(opts.interval && { interval: opts.interval }),
        ...(opts.limit && { limit: opts.limit }),
      }),
      spinner: 'scanning…',
    }));
}
