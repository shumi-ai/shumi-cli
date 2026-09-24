import { Option } from 'commander';
import chalk from 'chalk';
import { apiGet } from '../lib/api-client.js';
import { resolveMode } from '../lib/output.js';
import { resolveScan } from '../lib/scanResolve.js';
import { typedAction, addUniversalFlags } from '../lib/typedCmd.js';

/** Sort keys /api/coins/filter accepts. change24h / change7d answer "what's pumping". */
export const SCAN_SORT_FIELDS = ['marketCap', 'change24h', 'change7d', 'streak', 'price'];

/**
 * Map CLI flags to the query /api/coins/filter reads. The server silently
 * ignores unknown keys, so these names must be ITS names (categories,
 * marketCapMin, …). Sending category / mcap_min / mcap_max / exchange, as this
 * command used to, meant those filters never applied.
 */
export function scanQuery(opts) {
  return {
    ...(opts.trend && { trend: opts.trend }),
    ...(opts.category && { categories: opts.category }),
    ...(opts.mcapMin && { marketCapMin: opts.mcapMin }),
    ...(opts.mcapMax && { marketCapMax: opts.mcapMax }),
    ...(opts.exchange && { exchanges: opts.exchange }),
    ...(opts.interval && { interval: opts.interval }),
    ...(opts.limit && { limit: opts.limit }),
    ...(opts.sort && { sortBy: opts.sort }),
    ...(opts.order && { sortOrder: opts.order }),
  };
}

/**
 * Scan with category/exchange name resolution (see lib/scanResolve.js). A resolved name is
 * reported: in env.meta.resolved for machines, and as a dim line on stderr at a terminal.
 */
export async function scanFetch(route, query, opts = {}, get = apiGet) {
  const { env, notes } = await resolveScan(query, get);
  if (!notes.length) return env;
  if (!resolveMode(opts).json) process.stderr.write(chalk.dim(`  (${notes.join('; ')})\n`));
  return { ...env, meta: { ...(env?.meta || {}), resolved: notes } };
}

/**
 * Typed scan command.
 */
export function registerScanCommand(program) {
  program
    .command('scan')
    .description('filter coins by trend, category, market cap, exchange; sort by market cap or 24h change')
    .option('--trend <direction>', 'filter by trend (UP, HODL, DOWN)')
    .option('--category <name>', 'one category, exact name (e.g. Meme, Layer-2; see `shumi category list`)')
    .option('--mcap-min <n>', 'minimum market cap in USD')
    .option('--mcap-max <n>', 'maximum market cap in USD')
    .option('--exchange <name>', 'exchange by full venue name (e.g. Binance, "Coinbase Exchange")')
    .option('--interval <interval>', 'trend interval (1d, 1w)')
    .option('--limit <n>', 'max results')
    .addOption(new Option('--sort <field>', 'sort key (default marketCap); change24h / change7d = top movers').choices(SCAN_SORT_FIELDS))
    .addOption(new Option('--order <dir>', 'desc (default) = largest first, asc = smallest first').choices(['asc', 'desc']))
    .addHelpText('after', '\nTop 24h gainers: shumi scan --sort change24h --limit 10\nTop 24h losers:  shumi scan --sort change24h --order asc --limit 10\nTop 7d gainers:  shumi scan --sort change7d --limit 10')
    .action(typedAction({
      route: 'scan',
      query: (ctx, opts) => scanQuery(opts),
      fetch: scanFetch,
      spinner: 'scanning…',
    }));
}
