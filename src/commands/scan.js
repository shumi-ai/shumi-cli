import { Option } from 'commander';
import { apiGet } from '../lib/api-client.js';
import { canonicalCategory, rowsOf } from '../lib/scanResolve.js';
import { typedAction, addUniversalFlags } from '../lib/typedCmd.js';

/** Sort keys /api/coins/filter accepts. change24h / change7d answer "what's pumping". */
export const SCAN_SORT_FIELDS = ['marketCap', 'change24h', 'change7d', 'streak', 'price'];

/**
 * Map CLI flags to the query /api/cli/scan reads. Category and market cap go out under
 * the /api/coins/filter names (categories, marketCapMin, marketCapMax).
 *
 * --exchange goes out as `exchange`, NOT `exchanges`. /api/cli/scan refuses `exchange` with an
 * explanation, because the upstream `exchanges` filter only matches spot-ticker venue names:
 * "Hyperliquid" would come back as Hyperliquid spot listings only and "coinbase" as nothing,
 * both presented as the answer. Sending `exchanges` skipped that refusal. The server owns the
 * rule, so the flag is passed through and its 400 message reaches the user.
 */
export function scanQuery(opts) {
  return {
    ...(opts.trend && { trend: opts.trend }),
    ...(opts.category && { categories: opts.category }),
    ...(opts.mcapMin && { marketCapMin: opts.mcapMin }),
    ...(opts.mcapMax && { marketCapMax: opts.mcapMax }),
    ...(opts.exchange && { exchange: opts.exchange }),
    ...(opts.interval && { interval: opts.interval }),
    ...(opts.limit && { limit: opts.limit }),
    ...(opts.sort && { sortBy: opts.sort }),
    ...(opts.order && { sortOrder: opts.order }),
  };
}

export const EMPTY_SCAN_NOTE =
  'No coins matched these filters. `shumi category list` shows the valid category names.';

/**
 * One scan, one backend call. The server resolves category spelling (case, punctuation,
 * bracketed short forms) and answers an unknown name with a 400 listing close matches; the
 * few synonyms it cannot resolve ("l2", "memecoin") are rewritten locally first. A
 * comma-joined category is refused here, since the server reads it as one name. An empty
 * result with a category set comes back as the empty result plus `meta.note` (typedAction
 * prints it on stderr at a terminal, after the spinner stops), never an error.
 *
 * Should the backend wrap rows as `{ rows: [...], ...summary }`, the rows become `data` and the
 * summary moves to `meta.coverage`, so --fields and --top apply to the rows.
 */
export async function scanFetch(route, query, opts = {}, get = apiGet) {
  const q = { ...query };
  if (q.categories && /[,;|]/.test(q.categories)) {
    const err = new Error(`One category per scan: "${q.categories}" is matched as a single name and matches nothing.`);
    err.status = 400;
    err.body = { error: { code: 'BAD_REQUEST', message: err.message } };
    throw err;
  }
  const notes = [];
  if (q.categories) {
    const c = canonicalCategory(q.categories);
    if (c !== q.categories) notes.push(`category "${q.categories}" sent as "${c}".`);
    q.categories = c;
  }

  let env = await get(route, q);
  const data = env?.data;
  if (data && !Array.isArray(data) && Array.isArray(data.rows)) {
    const { rows, ...coverage } = data;
    env = { ...env, data: rows, meta: { ...(env.meta || {}), coverage } };
  }
  if (q.categories && rowsOf(env?.data).length === 0) notes.push(EMPTY_SCAN_NOTE);
  if (!notes.length) return env;
  return { ...env, meta: { ...(env?.meta || {}), note: notes.join(' ') } };
}

/**
 * Typed scan command.
 */
export function registerScanCommand(program) {
  program
    .command('scan')
    .description('filter coins by trend, category, market cap; sort by market cap or 24h change')
    .option('--trend <direction>', 'filter by trend (UP, HODL, DOWN)')
    .option('--category <name>', 'one category (e.g. Meme, "Layer 2", DeFi; see `shumi category list`)')
    .option('--mcap-min <n>', 'minimum market cap in USD')
    .option('--mcap-max <n>', 'maximum market cap in USD')
    .option('--exchange <name>', 'not supported on scan yet: the server refuses it with an explanation')
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
