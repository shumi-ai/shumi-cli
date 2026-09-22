/**
 * Apply default schemas to every typed command that doesn't already have one.
 * Hand-tuned `withSchema(cmd, ...)` calls in individual command files take
 * precedence — we only fill in the gap so `shumi commands --json` reports
 * a usable shape for every endpoint.
 *
 * Pattern-matched by command path (e.g. "coin.risk", "futures.history").
 * Anything unmatched gets a generic envelope schema with a `kind` of 'object'
 * and a note pointing the agent at `--json` for the real shape.
 */
import { getSchema, withSchema } from './schema.js';

const SCHEMAS = {
  // Coin
  'coin.sentiment':    { kind: 'object', fields: { symbol: 'string', success: 'boolean', data: 'object — sentiment summary fields' } },
  'coin.historical':   { kind: 'object', fields: { marketCap: 'number|null', volume: 'number|null', openInterest: 'number', fundingRate: 'number', futuresVolume24h: 'number', priceUSD: 'number' } },
  'coin.by-id':        { kind: 'object', fields: { coin: 'object — { id, name, symbol, marketCap, ... }', trends: 'array', average_streak: 'number' } },
  'coin.by-name':      { kind: 'object', fields: { coin: 'object — { id, name, symbol, ... }', trends: 'array', average_streak: 'number' } },
  'coin.by-contract':  { kind: 'object', fields: { coin: 'object — { id, name, symbol, ... }' }, note: 'requires --chain' },
  'coin.lookup':       { kind: 'object', fields: { coin: 'object — { id, name, symbol, marketCap }', trends: 'array' } },

  // Market
  'market.prices':     { kind: 'object', fields: { prices: 'object — keyed by coin id, each {coinId, price, source, ts}', ts: 'number — unix ms', baselines: 'object — optional, when --baselines' } },
  'market.global':     { kind: 'object', fields: { totalMarketCap: 'object — time series', totalMarketVolume: 'object', marketCapPercentage: 'object — dominance by symbol' } },
  'market.crossing':   { kind: 'object', fields: { crossings: 'array — fired crossings (often empty)', message: 'string — optional' } },
  'market.health':     { kind: 'object', fields: { date: 'ISO timestamp', trends: 'object — { UP, HODL, DOWN } counts', hasExtremes: 'boolean', extremes: 'array' } },
  'market.baselines':  { kind: 'object', fields: { baselines: 'object — keyed by id, each { b4h, b24h, b7d }', ts: 'number — unix ms' } },

  // Category
  'category.list':         { kind: 'array', fields: { '_item': 'string — category name' } },
  'category.info':         { kind: 'object', fields: { name: 'string', coins: 'array' } },
  'category.coins':        { kind: 'array', fields: { '_item': 'object — { id, name, symbol, marketCap, ... }' } },
  'category.sentiment':    { kind: 'object', fields: { success: 'boolean', data: 'object — sentiment summary for the category' } },

  // Sentiment
  'sentiment':             { kind: 'object', fields: { success: 'boolean', data: 'array — sentiment items' }, note: 'default action returns market sentiment; subcommands change shape' },
  'sentiment.latest':      { kind: 'object', fields: { success: 'boolean', data: 'array of {entity_id, stance, summary, created_at}' } },
  'sentiment.market':      { kind: 'object', fields: { success: 'boolean', data: 'array — market-wide sentiment items' } },
  'sentiment.summary':     { kind: 'object', fields: { id: 'number', type: 'string', entity_id: 'string', created_at: 'ISO timestamp', summary: 'string', stance: 'enum: accumulation|distribution|euphoria|capitulation|exhaustion|neutral' } },
  'sentiment.narratives':  { kind: 'object', fields: { success: 'boolean', interval: 'enum', total_count: 'number', sources: 'array', attention_state: 'object', freshness_score: 'number' } },
  'sentiment.categories':  { kind: 'object', fields: { success: 'boolean', interval: 'enum', total_count: 'number', categories: 'array' } },
  'sentiment.health':      { kind: 'object', fields: { ok: 'boolean', checks: 'array — sentiment-engine health checks' } },
  'sentiment.slopes':      { kind: 'object', fields: { snapshot_hour: 'ISO timestamp', count: 'number', categories: 'array' } },
  'sentiment.entity-slopes': { kind: 'object', fields: { snapshot_hour: 'ISO timestamp', count: 'number' } },
  'sentiment.coin':        { kind: 'object', fields: { success: 'boolean', symbol: 'string', data: 'object — coin-specific sentiment' } },
  'sentiment.category':    { kind: 'object', fields: { success: 'boolean', data: 'object — category sentiment' } },
  'sentiment.narrative':   { kind: 'object', fields: { success: 'boolean', data: 'object — single-narrative sentiment' } },

  // Trends
  'trends':                { kind: 'array', fields: { '_item': 'object — { name, trend, streak, ... }' }, note: 'default is fresh; see subcommands' },
  'trends.fresh':          { kind: 'array', fields: { '_item': 'object — coins with recently-flipped trends' } },
  'trends.stale':          { kind: 'array', fields: { '_item': 'object — coins with longest-running trends' } },
  'trends.aligned':        { kind: 'array', fields: { '_item': 'object — { name, trend, intervals } trend agrees across timeframes' } },
  'trends.extreme':        { kind: 'array', fields: { '_item': 'string|object — extremely-trending coin' } },
  'trends.historical':     { kind: 'array', fields: { '_item': 'object — historical trend snapshot' } },

  // Narratives / Scan
  'narratives':            { kind: 'object', fields: { success: 'boolean', sources: 'array', attention_state: 'object', freshness_score: 'number' }, note: 'no arg = list active; with name arg = sentiment for that narrative' },
  'scan':                  { kind: 'array', fields: { '_item': 'object — coin matching filter criteria' }, note: 'filters: --trend, --category, --mcap-min/max, --exchange, --limit' },

  // Regime
  'regime':                { kind: 'object', fields: { positions: 'array of {symbol, regime, conviction, ...}', meta: 'object' }, note: 'default action=active; see subcommands' },
  'regime.active':         { kind: 'object', fields: { positions: 'array of active regime positions', meta: 'object' } },
  'regime.signals':        { kind: 'object', fields: { signals: 'array', meta: 'object' } },
  'regime.confidence':     { kind: 'object', fields: { source: 'string', generated: 'ISO timestamp', summary: 'object', coins: 'array — { symbol, regime, confidence }' } },
  'regime.history':        { kind: 'object', fields: { symbol: 'string', trades: 'array', summary: 'object', currentPosition: 'object|null' } },

  // Futures
  'futures':               { kind: 'object', fields: { signals: 'array of {asset, signalType, entryPrice, ...}', meta: 'object' }, note: 'default action=state' },
  'futures.state':         { kind: 'object', fields: { signals: 'array — current open setups', meta: 'object' } },
  'futures.log':           { kind: 'object', fields: { log: 'array — recent push history', meta: 'object' } },
  'futures.history':       { kind: 'object', fields: { asset: 'string', active: 'array', resolved: 'array', summary: 'object — { totalSignals, wins, losses, winRate }' } },

  // Walkforward
  'walkforward':           { kind: 'object', fields: { signals: 'array', meta: 'object' }, note: 'default action=signals' },
  'walkforward.signals':   { kind: 'object', fields: { signals: 'array of walkforward signal records', meta: 'object' } },
  'walkforward.positions': { kind: 'object', fields: { positions: 'array of currently-open backtest positions', meta: 'object' } },
  'walkforward.outcomes':  { kind: 'object', fields: { outcomes: 'array of resolved trades', summary: 'object — { wins, losses, winRate, ... }' } },

  // Pairs
  'pairs':                 { kind: 'object', fields: { suggestions: 'array', timestamp: 'ISO timestamp' }, note: 'default action=suggestions; see subcommands' },
  'pairs.suggestions':     { kind: 'object', fields: { suggestions: 'array of {pair, ratio, signal, ...}', timestamp: 'ISO timestamp', totalPairsAnalyzed: 'number', filters: 'object' } },
  'pairs.history':         { kind: 'object', fields: { history: 'array of completed pair trades' } },
  'pairs.signal':          { kind: 'object', fields: { pair: 'string', signal: 'string', ratio: 'number' }, note: 'requires --token-a and --token-b' },
  'pairs.delta-neutral':   { kind: 'object', fields: { suggestions: 'array of {symbol, longExchange, shortExchange, netApr, ...}', timestamp: 'ISO timestamp' } },

  // Tracking
  'holders':                { kind: 'object', fields: { watchlist: 'array — contracts being tracked', meta: 'object' }, note: 'default action=watchlist' },
  'holders.watchlist':      { kind: 'object', fields: { watchlist: 'array — { contract, label, chainId, ... }', meta: 'object' } },
  'holders.movements':      { kind: 'object', fields: { movements: 'array — { contract, holder, delta, ts }', meta: 'object — { total, contract, chainId }' }, note: 'requires --contract' },
  'wallets':                { kind: 'object', fields: { watchlist: 'array — wallets being tracked', meta: 'object' }, note: 'default action=watchlist' },
  'wallets.watchlist':      { kind: 'object', fields: { watchlist: 'array — { walletAddress, chainId, label, ... }', meta: 'object' } },
  'wallets.movements':      { kind: 'object', fields: { movements: 'array — { address, token, delta, ts }', meta: 'object — { total, address, chainId }' }, note: 'requires --address' },

  // Transcripts / Basket
  'transcripts':            { kind: 'object', fields: { highlights: 'array', meta: 'object' }, note: 'default action=highlights' },
  'transcripts.sources':    { kind: 'object', fields: { sources: 'array of transcript-producing channels', meta: 'object' } },
  'transcripts.highlights': { kind: 'object', fields: { highlights: 'array of clip-level highlights', meta: 'object — { total, by_source }' } },
  'basket':                 { kind: 'object', fields: { snapshots: 'array of basket composition snapshots over time', meta: 'object' } },

  // Signal quality
  'signal-quality':         { kind: 'object', fields: { reliability_tier: 'enum: PRELIMINARY|VALIDATED|INSUFFICIENT_DATA', confidence: 'number|null', validations: 'object', message: 'string' }, note: 'requires --asset' },

  // Tweets / Search / Ask
  'tweets':                 { kind: 'string|object', fields: {}, note: 'NLP — returns markdown text via /api/cli' },
  'search':                 { kind: 'string|object', fields: {}, note: 'NLP — returns markdown text. --answer for direct answer' },
  'ask':                    { kind: 'string|object', fields: {}, note: 'NLP — free-form question. Slow path (5–10s).' },

  // Auth / utility
  'login':                  { kind: 'side-effect', fields: {}, note: 'opens browser for Dynamic.xyz wallet auth; writes JWT to ~/.shumi/config.json' },
  'logout':                 { kind: 'side-effect', fields: {}, note: 'clears stored credentials' },
  'whoami':                 { kind: 'object', fields: { wallet: 'string', status: 'enum: authenticated|unauthenticated' } },
  'health':                 { kind: 'object', fields: { service: 'enum: online|offline', auth: 'enum', wallet: 'string', device: 'string' } },
  'keys':                   { kind: 'side-effect', fields: {}, note: 'see subcommands' },
  'keys.create':            { kind: 'object', fields: { key: 'string — shumi_sk_* (shown ONCE)', name: 'string' }, note: 'requires JWT auth (shumi login first); save the key immediately' },
  'keys.list':              { kind: 'object', fields: { keys: 'array of { prefix, name, created_at, revoked_at, expires_at }' } },
  'keys.revoke':            { kind: 'side-effect', fields: {}, note: 'argument: the prefix from `keys list`' },
};

export function applyBulkSchemas(program) {
  walk(program, '');
}

function walk(cmd, prefix) {
  for (const sub of cmd.commands || []) {
    const name = sub.name();
    if (name === 'help') continue;
    const path = prefix ? `${prefix}.${name}` : name;
    if (!getSchema(sub) && SCHEMAS[path]) {
      withSchema(sub, SCHEMAS[path]);
    }
    if (sub.commands?.length) walk(sub, path);
  }
}
