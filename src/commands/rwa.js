import { typedAction, addUniversalFlags } from '../lib/typedCmd.js';
import { withSchema } from '../lib/schema.js';

/**
 * Real-world assets (RWA): stocks/ETFs, metals, commodities, indices, FX traded as perps on
 * Hyperliquid builder DEXes. Thin typed commands over /api/cli/rwa/* — mirrors the coin tree.
 * Additive: does not touch `coin`, `market`, `signal`, or the `<symbol>` shortcut.
 */
export function registerRwaCommand(program) {
  const rwa = program
    .command('rwa')
    .description('real-world assets: stocks/ETFs, metals, commodities, indices, FX (perps on HL builder DEXes)')
    .action(function () { this.help(); });

  const list = rwa
    .command('list')
    .description('list real-world assets, optionally filtered by class or builder dex')
    .option('--type <type>', 'asset class: equity | etf | commodity | index | fx')
    .option('--dex <dex>', 'builder dex slug (e.g. xyz)')
    .action(typedAction({
      route: 'rwa/assets',
      query: (ctx, opts) => ({ ...(opts.type && { type: opts.type }), ...(opts.dex && { dex: opts.dex }) }),
      spinner: 'real-world assets…',
    }));
  addUniversalFlags(list);
  withSchema(list, {
    kind: 'object with array',
    fields: { count: 'number', assets: 'array<{ id, symbol, name, assetType, venue }>' },
  });

  const lookup = rwa
    .command('lookup')
    .argument('<symbol>', 'ticker (e.g. AAPL, GOLD)')
    .description('look up a real-world asset by ticker symbol')
    .action(typedAction({
      route: (ctx) => `rwa/symbol/${encodeURIComponent(ctx.args[0])}`,
      spinner: (ctx) => `rwa ${ctx.args[0]}…`,
    }));
  addUniversalFlags(lookup);

  const asset = rwa
    .command('asset')
    .argument('<id>', 'namespaced id (e.g. xyz:AAPL, xyz:GOLD)')
    .description('look up a real-world asset by namespaced id')
    .action(typedAction({
      route: (ctx) => `rwa/asset/${encodeURIComponent(ctx.args[0])}`,
      spinner: (ctx) => `rwa ${ctx.args[0]}…`,
    }));
  addUniversalFlags(asset);

  const rwaSchema = {
    kind: 'object',
    fields: {
      id: 'string', symbol: 'string', name: 'string', assetType: 'string',
      venue: 'string', price: 'number', priceAsOf: 'string',
      trend: 'object<{ daily, weekly }>',
    },
  };
  withSchema(lookup, rwaSchema);
  withSchema(asset, rwaSchema);

  // Friendly top-level aliases for the common cases. Both resolve by ticker symbol.
  for (const [name, label] of [['stock', 'stock'], ['commodity', 'commodity']]) {
    const alias = program
      .command(name)
      .argument('<symbol>', `${label} ticker (e.g. ${name === 'stock' ? 'AAPL' : 'GOLD'})`)
      .description(`look up a ${label} (alias for \`rwa lookup\`)`)
      .action(typedAction({
        route: (ctx) => `rwa/symbol/${encodeURIComponent(ctx.args[0])}`,
        spinner: (ctx) => `${label} ${ctx.args[0]}…`,
      }));
    addUniversalFlags(alias);
    withSchema(alias, rwaSchema);
  }
}
