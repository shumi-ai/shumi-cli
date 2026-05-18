import { typedAction, addUniversalFlags } from '../lib/typedCmd.js';

/**
 * Typed sentiment command tree. Replaces the prior NLP-only `shumi sentiment`.
 * Default action (`shumi sentiment` with no subcommand) returns market sentiment.
 */
export function registerSentimentCommand(program) {
  const sent = program
    .command('sentiment')
    .description('sentiment analysis (market, coin, category, narrative, slopes)')
    .action(typedAction({ route: 'sentiment', query: { action: 'market' }, spinner: 'market sentiment…' }));

  for (const action of ['latest', 'market', 'summary', 'narratives', 'categories', 'health', 'slopes', 'entity-slopes']) {
    sent.command(action)
      .description(`sentiment ${action}`)
      .action(typedAction({ route: 'sentiment', query: { action }, spinner: `sentiment ${action}…` }));
  }

  sent.command('coin')
    .argument('<symbol>', 'coin symbol')
    .description('sentiment for a coin')
    .action(typedAction({
      route: 'sentiment',
      query: (ctx) => ({ action: 'coin', symbol: ctx.args[0] }),
      spinner: (ctx) => `sentiment for ${ctx.args[0]}…`,
    }));

  sent.command('category')
    .argument('<name>', 'category name')
    .description('sentiment for a category')
    .action(typedAction({
      route: 'sentiment',
      query: (ctx) => ({ action: 'category', name: ctx.args[0] }),
      spinner: (ctx) => `sentiment for ${ctx.args[0]}…`,
    }));

  sent.command('narrative')
    .argument('<name>', 'narrative name')
    .description('sentiment for a narrative')
    .action(typedAction({
      route: 'sentiment',
      query: (ctx) => ({ action: 'narrative', name: ctx.args[0] }),
      spinner: (ctx) => `sentiment for ${ctx.args[0]}…`,
    }));
}
