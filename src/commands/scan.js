import { Option } from 'commander';
import { apiGet } from '../lib/api-client.js';
import { canonicalCategory, canonicalExchange, rowsOf } from '../lib/scanResolve.js';
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

export const EMPTY_SCAN_NOTE =
  'No coins matched. Category names are exact and case-sensitive (e.g. Meme, Layer-2); `shumi category list` shows them. Exchanges need the full venue name (e.g. "Coinbase Exchange").';

/**
 * One scan, one backend call. Known misspellings of big categories and short venue names
 * are rewritten locally first (static maps in lib/scanResolve.js, no network). A comma-joined
 * category is refused, since it is matched as one name and can only return nothing. An empty
 * result with a category or exchange set comes back as the empty result plus `meta.note`
 * (typedAction prints it on stderr at a terminal, after the spinner stops), never an error.
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
  if (q.exchanges) {
    const e = canonicalExchange(q.exchanges);
    if (e !== q.exchanges) notes.push(`exchange "${q.exchanges}" sent as "${e}".`);
    q.exchanges = e;
  }

  let env = await get(route, q);
  const data = env?.data;
  if (data && !Array.isArray(data) && Array.isArray(data.rows)) {
    const { rows, ...coverage } = data;
    env = { ...env, data: rows, meta: { ...(env.meta || {}), coverage } };
  }
  if ((q.categories || q.exchanges) && rowsOf(env?.data).length === 0) notes.push(EMPTY_SCAN_NOTE);
  if (!notes.length) return env;
  return { ...env, meta: { ...(env?.meta || {}), note: notes.join(' ') } };
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
