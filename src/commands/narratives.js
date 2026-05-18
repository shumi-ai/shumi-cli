import { typedAction, addUniversalFlags } from '../lib/typedCmd.js';

/**
 * Typed narratives commands. `shumi narratives` lists active narratives;
 * `shumi narratives <name>` returns sentiment for that narrative
 * (equivalent to `shumi sentiment narrative <name>`).
 */
export function registerNarrativesCommand(program) {
  program
    .command('narratives')
    .argument('[name]', 'narrative name (omit to list all active)')
    .description('list active narratives or get sentiment for one')
    .action(typedAction({
      route: (ctx) => ctx.args[0] ? 'sentiment' : 'narratives',
      query: (ctx) => ctx.args[0] ? { action: 'narrative', name: ctx.args[0] } : {},
      spinner: (ctx) => ctx.args[0] ? `narrative ${ctx.args[0]}…` : 'active narratives…',
    }));
}
